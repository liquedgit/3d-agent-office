"""State store for the agent office — SQLite, one file, concurrency-safe.

Every row belongs to a project ("room"). All functions take `project="default"`
so callers that predate multi-project support keep working unchanged.
"""
import json
import logging
import math
import os
import re
import sqlite3
import time
from pathlib import Path

DB_PATH = Path(os.environ.get(
    "OFFICE_DB",
    str(Path(__file__).resolve().parent.parent / "office.db"),
))

DEFAULT_PROJECT = "default"

log = logging.getLogger(__name__)


def _now():
    return int(time.time())


def connect():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def _columns(conn, table):
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}


def init_db():
    conn = connect()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS agents (
            project_id TEXT NOT NULL DEFAULT 'default',
            id TEXT NOT NULL,
            role TEXT NOT NULL,          -- ceo | engineer | qa
            name TEXT NOT NULL,
            desk_x REAL NOT NULL,
            desk_y REAL NOT NULL,
            status TEXT DEFAULT 'idle',  -- idle|thinking|working|testing|blocked|waiting|done
            current_task TEXT,
            model TEXT DEFAULT '',
            effort TEXT DEFAULT '',
            PRIMARY KEY (project_id, id)
        );
        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT NOT NULL DEFAULT 'default',
            title TEXT NOT NULL,
            description TEXT DEFAULT '',
            status TEXT DEFAULT 'todo',  -- todo|in_progress|review|done|blocked
            assignee TEXT,
            created_at INTEGER,
            updated_at INTEGER,
            depends_on TEXT DEFAULT '[]',     -- JSON array of task ids (same project) this task waits on
            attempts INTEGER DEFAULT 0,       -- consecutive failures in the current block cycle
            block_cycles INTEGER DEFAULT 0,   -- times it has been blocked so far
            blocked_until INTEGER DEFAULT 0   -- epoch the block cooldown ends; 0 = not blocked
        );
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT NOT NULL DEFAULT 'default',
            agent_id TEXT,
            type TEXT DEFAULT 'info',    -- info|success|error|think|talk
            message TEXT,
            ts INTEGER
        );
        CREATE TABLE IF NOT EXISTS conversation (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT NOT NULL DEFAULT 'default',
            speaker TEXT NOT NULL,       -- user | ceo
            message TEXT NOT NULL,
            ts INTEGER
        );
        CREATE TABLE IF NOT EXISTS metrics (
            project_id TEXT NOT NULL DEFAULT 'default',
            key TEXT NOT NULL,
            value INTEGER DEFAULT 0,
            PRIMARY KEY (project_id, key)
        );
        """
    )
    _migrate_v1(conn)
    _migrate_task_columns(conn)
    conn.executescript(
        """
        CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, id);
        CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id, id);
        CREATE INDEX IF NOT EXISTS idx_conversation_project ON conversation(project_id, id);
        """
    )
    conn.execute("INSERT OR IGNORE INTO projects (id, name, created_at) VALUES (?,?,?)",
                 (DEFAULT_PROJECT, "Default", _now()))
    conn.commit()
    conn.close()


def _migrate_v1(conn):
    """Upgrade a pre-project (v1) database in place; existing rows land in 'default'."""
    # agents/metrics need a new composite primary key -> rebuild the table
    if "project_id" not in _columns(conn, "agents"):
        conn.executescript(
            """
            ALTER TABLE agents RENAME TO agents_v1;
            CREATE TABLE agents (
                project_id TEXT NOT NULL DEFAULT 'default',
                id TEXT NOT NULL,
                role TEXT NOT NULL,
                name TEXT NOT NULL,
                desk_x REAL NOT NULL,
                desk_y REAL NOT NULL,
                status TEXT DEFAULT 'idle',
                current_task TEXT,
                model TEXT DEFAULT '',
                effort TEXT DEFAULT '',
                PRIMARY KEY (project_id, id)
            );
            INSERT INTO agents (project_id, id, role, name, desk_x, desk_y, status, current_task, model, effort)
                SELECT 'default', id, role, name, desk_x, desk_y, status, current_task, model, effort FROM agents_v1;
            DROP TABLE agents_v1;
            """
        )
    if "project_id" not in _columns(conn, "metrics"):
        conn.executescript(
            """
            ALTER TABLE metrics RENAME TO metrics_v1;
            CREATE TABLE metrics (
                project_id TEXT NOT NULL DEFAULT 'default',
                key TEXT NOT NULL,
                value INTEGER DEFAULT 0,
                PRIMARY KEY (project_id, key)
            );
            INSERT INTO metrics (project_id, key, value) SELECT 'default', key, value FROM metrics_v1;
            DROP TABLE metrics_v1;
            """
        )
    # append-only tables keep their global AUTOINCREMENT ids; just add the column
    for table in ("tasks", "events", "conversation"):
        if "project_id" not in _columns(conn, table):
            conn.execute(f"ALTER TABLE {table} ADD COLUMN project_id TEXT NOT NULL DEFAULT 'default'")
    conn.commit()


# Task columns added after the first release: (name, declaration).
TASK_COLUMNS = (
    ("depends_on", "TEXT DEFAULT '[]'"),
    ("attempts", "INTEGER DEFAULT 0"),
    ("block_cycles", "INTEGER DEFAULT 0"),
    ("blocked_until", "INTEGER DEFAULT 0"),
)


def _migrate_task_columns(conn):
    """Add the dependency / blocked-recovery columns to a tasks table that predates them."""
    have = _columns(conn, "tasks")
    for name, decl in TASK_COLUMNS:
        if name not in have:
            conn.execute(f"ALTER TABLE tasks ADD COLUMN {name} {decl}")
    conn.commit()


# ---------- team generator ----------

CEO_AGENT = ("ceo", "ceo", "Suwandi", 0.50, 0.20)
ENGINEER_NAMES = ["Michael", "Tubagus", "Prasetya", "Wahyudi", "Devan", "Fajar",
                  "Galih", "Hendra", "Iwan", "Joko", "Krisna", "Lukman"]
QA_NAMES = ["Richfal", "Shulkhan", "Taufik", "Umar", "Vino", "Yusuf"]


def _pool_name(pool, i):
    """Name of the i-th (0-based) hire: the pool first, then 'Michael 2', 'Tubagus 2', ..."""
    name = pool[i % len(pool)]
    return name if i < len(pool) else f"{name} {i // len(pool) + 1}"


def _spread(lo, hi, n):
    if n < 2:
        return [round((lo + hi) / 2, 3)]
    return [round(lo + (hi - lo) * k / (n - 1), 3) for k in range(n)]


def _engineer_desks(n):
    """n distinct desks in the left/centre work area, filled row by row."""
    cols = max(2, math.ceil(math.sqrt(n)))
    rows = math.ceil(n / cols)
    xs = [0.20, 0.35] if cols == 2 else _spread(0.15, 0.45, cols)
    ys = [0.45, 0.70] if rows <= 2 else _spread(0.30, 0.78, rows)
    return [(xs[i % cols], ys[i // cols]) for i in range(n)]


def _qa_desks(n):
    """n distinct desks down the right side; a further column opens every 6 QAs."""
    cols = max(1, math.ceil(n / 6))
    rows = math.ceil(n / cols)
    xs = [0.72] if cols == 1 else _spread(0.72, 0.92, cols)
    ys = [0.50, 0.72] if rows <= 2 else _spread(0.35, 0.78, rows)
    return [(xs[i // rows], ys[i % rows]) for i in range(n)]


def generate_team(num_engineers=4, num_qas=2):
    """CEO + eng1..engN + qa1..qaM as (id, role, name, desk_x, desk_y), with unique
    names and desks that never overlap. Deterministic for a given pair of counts."""
    team = [CEO_AGENT]
    for i, (x, y) in enumerate(_engineer_desks(max(0, int(num_engineers)))):
        team.append((f"eng{i + 1}", "engineer", _pool_name(ENGINEER_NAMES, i), x, y))
    for i, (x, y) in enumerate(_qa_desks(max(0, int(num_qas)))):
        team.append((f"qa{i + 1}", "qa", _pool_name(QA_NAMES, i), x, y))
    return team


DEFAULT_AGENTS = generate_team(4, 2)  # the initial 7-agent office
DEFAULT_METRICS = ["commits", "tests_passed", "tests_failed", "floors", "tasks_done"]


def seed_defaults(project=DEFAULT_PROJECT):
    """Idempotent: populate a default idle office if the project has no agents."""
    if get_agents(project):
        return False
    for agent_id, role, name, x, y in DEFAULT_AGENTS:
        upsert_agent(agent_id, role, name, x, y, status="idle", project=project)
    for k in DEFAULT_METRICS:
        set_metric(k, 0, project=project)
    return True


# ---------- projects ----------

def get_projects():
    conn = connect()
    # 'default' always first, then rooms in creation order
    rows = conn.execute("SELECT * FROM projects ORDER BY id != ?, created_at, id",
                        (DEFAULT_PROJECT,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def project_exists(project):
    conn = connect()
    r = conn.execute("SELECT 1 FROM projects WHERE id=?", (project,)).fetchone()
    conn.close()
    return r is not None


def _slug(name):
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40].strip("-")
    return s or "project"


def create_project(name):
    """Create a project (with its own seeded team) and return its id."""
    name = (name or "").strip()[:80] or "Untitled"
    base = _slug(name)
    conn = connect()
    pid, n = base, 2
    while conn.execute("SELECT 1 FROM projects WHERE id=?", (pid,)).fetchone():
        pid = f"{base}-{n}"; n += 1
    conn.execute("INSERT INTO projects (id, name, created_at) VALUES (?,?,?)", (pid, name, _now()))
    conn.commit()
    conn.close()
    seed_defaults(pid)
    return pid


# ---------- agents ----------

def upsert_agent(agent_id, role, name, desk_x, desk_y, status=None, current_task=None, model="", effort="",
                 project=DEFAULT_PROJECT):
    conn = connect()
    conn.execute(
        """INSERT INTO agents (project_id, id, role, name, desk_x, desk_y, status, current_task, model, effort)
           VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(project_id, id) DO UPDATE SET
             role=excluded.role, name=excluded.name, desk_x=excluded.desk_x, desk_y=excluded.desk_y,
             status=COALESCE(excluded.status, agents.status),
             current_task=COALESCE(excluded.current_task, agents.current_task),
             model=excluded.model, effort=excluded.effort""",
        (project, agent_id, role, name, desk_x, desk_y, status, current_task, model, effort),
    )
    conn.commit()
    conn.close()


def set_agent_status(agent_id, status=None, current_task=None, model=None, effort=None, project=DEFAULT_PROJECT):
    conn = connect()
    fields, vals = [], []
    if status is not None:
        fields.append("status=?"); vals.append(status)
    if current_task is not None:
        fields.append("current_task=?"); vals.append(current_task)
    if model is not None:
        fields.append("model=?"); vals.append(model)
    if effort is not None:
        fields.append("effort=?"); vals.append(effort)
    if fields:
        vals += [project, agent_id]
        conn.execute(f"UPDATE agents SET {', '.join(fields)} WHERE project_id=? AND id=?", vals)
        conn.commit()
    conn.close()


def get_agents(project=DEFAULT_PROJECT):
    conn = connect()
    rows = conn.execute("SELECT * FROM agents WHERE project_id=? ORDER BY rowid", (project,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_agent(agent_id, project=DEFAULT_PROJECT):
    conn = connect()
    r = conn.execute("SELECT * FROM agents WHERE project_id=? AND id=?", (project, agent_id)).fetchone()
    conn.close()
    return dict(r) if r else None


def sync_team(num_engineers, num_qas, project=DEFAULT_PROJECT):
    """Make sure the project has a CEO plus eng1..engN and qa1..qaM; returns the ids added.

    Idempotent, and nobody is ever removed: agents beyond the counts stay where they are.
    When someone is added, the engineers/QAs within the counts are re-seated on the grid
    for the new team size so desks never overlap; they keep their name, status and task.
    """
    existing = {a["id"]: a for a in get_agents(project)}
    team = generate_team(num_engineers, num_qas)
    added = [agent_id for agent_id, *_ in team if agent_id not in existing]
    if not added:
        return []
    used = {a["name"] for a in existing.values()}
    conn = connect()
    for agent_id, role, name, x, y in team:
        if agent_id in existing:
            if role != "ceo":
                conn.execute("UPDATE agents SET desk_x=?, desk_y=? WHERE project_id=? AND id=?",
                             (x, y, project, agent_id))
            continue
        base, n = name, 2
        while name in used:  # e.g. a renamed colleague already took it
            name = f"{base} {n}"; n += 1
        used.add(name)
        conn.execute(
            "INSERT INTO agents (project_id, id, role, name, desk_x, desk_y, status) VALUES (?,?,?,?,?,?,?)",
            (project, agent_id, role, name, x, y, "idle"))
    conn.commit()
    conn.close()
    return added


# ---------- tasks ----------

def _clean_deps(deps, exclude=None):
    """Normalise a dependency list to unique positive int task ids (order kept)."""
    out = []
    for d in deps or []:
        if isinstance(d, bool) or not isinstance(d, (int, str)):
            continue
        try:
            d = int(d)
        except ValueError:
            continue
        if d > 0 and d != exclude and d not in out:
            out.append(d)
    return out


def _task(row):
    """Task row -> dict, with depends_on decoded to a list of ints."""
    t = dict(row)
    try:
        deps = json.loads(t.get("depends_on") or "[]")
    except ValueError:
        deps = []
    t["depends_on"] = _clean_deps(deps if isinstance(deps, list) else [])
    return t


def create_task(title, description="", assignee=None, project=DEFAULT_PROJECT, depends_on=None):
    conn = connect()
    cur = conn.execute(
        "INSERT INTO tasks (project_id, title, description, status, assignee, created_at, updated_at, depends_on)"
        " VALUES (?,?,?,?,?,?,?,?)",
        (project, title, description, "todo", assignee, _now(), _now(), json.dumps(_clean_deps(depends_on))),
    )
    conn.commit()
    tid = cur.lastrowid
    conn.close()
    return tid


def set_task_status(task_id, status, assignee=None, project=DEFAULT_PROJECT,
                    attempts=None, block_cycles=None, blocked_until=None):
    """Set a task's status; the recovery counters are written in the same statement when given."""
    fields, vals = ["status=?", "updated_at=?"], [status, _now()]
    for col, val in (("assignee", assignee), ("attempts", attempts),
                     ("block_cycles", block_cycles), ("blocked_until", blocked_until)):
        if val is not None:
            fields.append(f"{col}=?"); vals.append(val)
    conn = connect()
    conn.execute(f"UPDATE tasks SET {', '.join(fields)} WHERE id=? AND project_id=?", vals + [task_id, project])
    conn.commit()
    conn.close()


def set_task_deps(task_id, deps, project=DEFAULT_PROJECT):
    """Replace a task's dependency list (task ids in the same project; never itself)."""
    conn = connect()
    conn.execute("UPDATE tasks SET depends_on=?, updated_at=? WHERE id=? AND project_id=?",
                 (json.dumps(_clean_deps(deps, exclude=task_id)), _now(), task_id, project))
    conn.commit()
    conn.close()


def get_tasks(project=DEFAULT_PROJECT):
    conn = connect()
    rows = conn.execute("SELECT * FROM tasks WHERE project_id=? ORDER BY id", (project,)).fetchall()
    conn.close()
    return [_task(r) for r in rows]


def get_task(task_id, project=DEFAULT_PROJECT):
    conn = connect()
    r = conn.execute("SELECT * FROM tasks WHERE id=? AND project_id=?", (task_id, project)).fetchone()
    conn.close()
    return _task(r) if r else None


def deps_satisfied(task_id, project=DEFAULT_PROJECT):
    """True when every task this one depends on is 'done' in the same project.
    A dependency that doesn't exist (or lives in another project) counts as unsatisfied."""
    task = get_task(task_id, project)
    if not task:
        return False
    deps = task["depends_on"]
    if not deps:
        return True
    conn = connect()
    rows = conn.execute(
        f"SELECT id, status FROM tasks WHERE project_id=? AND id IN ({','.join('?' * len(deps))})",
        (project, *deps)).fetchall()
    conn.close()
    status = {r["id"]: r["status"] for r in rows}
    missing = [d for d in deps if d not in status]
    if missing:
        log.warning("task #%s in %s depends on missing task(s) %s", task_id, project, missing)
    return all(status.get(d) == "done" for d in deps)


def get_next_todo(project=DEFAULT_PROJECT):
    conn = connect()
    r = conn.execute("SELECT * FROM tasks WHERE project_id=? AND status='todo' ORDER BY id LIMIT 1",
                     (project,)).fetchone()
    conn.close()
    return _task(r) if r else None


# ---------- events ----------

def add_event(agent_id, message, type="info", project=DEFAULT_PROJECT):
    conn = connect()
    conn.execute("INSERT INTO events (project_id, agent_id, type, message, ts) VALUES (?,?,?,?,?)",
                 (project, agent_id, type, message, _now()))
    conn.commit()
    conn.close()


def get_events(limit=100, project=DEFAULT_PROJECT):
    conn = connect()
    rows = conn.execute("SELECT * FROM events WHERE project_id=? ORDER BY id DESC LIMIT ?",
                        (project, limit)).fetchall()
    conn.close()
    return [dict(r) for r in reversed(rows)]


# ---------- conversation ----------

def add_message(speaker, message, project=DEFAULT_PROJECT):
    conn = connect()
    conn.execute("INSERT INTO conversation (project_id, speaker, message, ts) VALUES (?,?,?,?)",
                 (project, speaker, message, _now()))
    conn.commit()
    conn.close()


def get_conversation(limit=200, project=DEFAULT_PROJECT):
    conn = connect()
    rows = conn.execute("SELECT * FROM conversation WHERE project_id=? ORDER BY id DESC LIMIT ?",
                        (project, limit)).fetchall()
    conn.close()
    return [dict(r) for r in reversed(rows)]


# ---------- metrics ----------

def set_metric(key, value, project=DEFAULT_PROJECT):
    conn = connect()
    conn.execute("""INSERT INTO metrics (project_id, key, value) VALUES (?,?,?)
                    ON CONFLICT(project_id, key) DO UPDATE SET value=excluded.value""",
                 (project, key, value))
    conn.commit()
    conn.close()


def incr_metric(key, delta=1, project=DEFAULT_PROJECT):
    conn = connect()
    conn.execute("""INSERT INTO metrics (project_id, key, value) VALUES (?,?,?)
                    ON CONFLICT(project_id, key) DO UPDATE SET value=value+excluded.value""",
                 (project, key, delta))
    conn.commit()
    conn.close()


def get_metrics(project=DEFAULT_PROJECT):
    conn = connect()
    rows = conn.execute("SELECT key, value FROM metrics WHERE project_id=?", (project,)).fetchall()
    conn.close()
    return {r["key"]: r["value"] for r in rows}


# ---------- snapshot (single payload for websocket) ----------

def snapshot(project=DEFAULT_PROJECT):
    return {
        "agents": get_agents(project),
        "tasks": get_tasks(project),
        "events": get_events(60, project),
        "conversation": get_conversation(200, project),
        "metrics": get_metrics(project),
    }

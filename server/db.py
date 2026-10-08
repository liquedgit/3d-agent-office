"""State store for the agent office — SQLite, one file, concurrency-safe.

Every row belongs to a project ("room"). All functions take `project="default"`
so callers that predate multi-project support keep working unchanged.
"""
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
            status TEXT DEFAULT 'todo',  -- todo|in_progress|review|done
            assignee TEXT,
            created_at INTEGER,
            updated_at INTEGER
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


DEFAULT_AGENTS = [
    ("ceo",  "ceo",  "Suwandi",     0.50, 0.20),
    ("eng1", "engineer", "Michael", 0.20, 0.45),
    ("eng2", "engineer", "Tubagus", 0.35, 0.45),
    ("eng3", "engineer", "Prasetya", 0.20, 0.70),
    ("eng4", "engineer", "Wahyudi", 0.35, 0.70),
    ("qa1",  "qa",   "Richfal",     0.72, 0.50),
    ("qa2",  "qa",   "Shulkhan",    0.72, 0.72),
]
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


# ---------- tasks ----------

def create_task(title, description="", assignee=None, project=DEFAULT_PROJECT):
    conn = connect()
    cur = conn.execute(
        "INSERT INTO tasks (project_id, title, description, status, assignee, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
        (project, title, description, "todo", assignee, _now(), _now()),
    )
    conn.commit()
    tid = cur.lastrowid
    conn.close()
    return tid


def set_task_status(task_id, status, assignee=None, project=DEFAULT_PROJECT):
    conn = connect()
    if assignee is not None:
        conn.execute("UPDATE tasks SET status=?, assignee=?, updated_at=? WHERE id=? AND project_id=?",
                     (status, assignee, _now(), task_id, project))
    else:
        conn.execute("UPDATE tasks SET status=?, updated_at=? WHERE id=? AND project_id=?",
                     (status, _now(), task_id, project))
    conn.commit()
    conn.close()


def get_tasks(project=DEFAULT_PROJECT):
    conn = connect()
    rows = conn.execute("SELECT * FROM tasks WHERE project_id=? ORDER BY id", (project,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_next_todo(project=DEFAULT_PROJECT):
    conn = connect()
    r = conn.execute("SELECT * FROM tasks WHERE project_id=? AND status='todo' ORDER BY id LIMIT 1",
                     (project,)).fetchone()
    conn.close()
    return dict(r) if r else None


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

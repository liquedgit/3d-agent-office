"""State store for the agent office — SQLite, one file, concurrency-safe."""
import os
import sqlite3
import time
from pathlib import Path

DB_PATH = Path(os.environ.get(
    "OFFICE_DB",
    str(Path(__file__).resolve().parent.parent / "office.db"),
))


def _now():
    return int(time.time())


def connect():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def init_db():
    conn = connect()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS agents (
            id TEXT PRIMARY KEY,
            role TEXT NOT NULL,          -- ceo | engineer | qa
            name TEXT NOT NULL,
            desk_x REAL NOT NULL,
            desk_y REAL NOT NULL,
            status TEXT DEFAULT 'idle',  -- idle|thinking|working|testing|blocked|waiting|done
            current_task TEXT,
            model TEXT DEFAULT '',
            effort TEXT DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT DEFAULT '',
            status TEXT DEFAULT 'todo',  -- todo|in_progress|review|done
            assignee TEXT,
            created_at INTEGER,
            updated_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agent_id TEXT,
            type TEXT DEFAULT 'info',    -- info|success|error|think|talk
            message TEXT,
            ts INTEGER
        );
        CREATE TABLE IF NOT EXISTS conversation (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            speaker TEXT NOT NULL,       -- user | ceo
            message TEXT NOT NULL,
            ts INTEGER
        );
        CREATE TABLE IF NOT EXISTS metrics (
            key TEXT PRIMARY KEY,
            value INTEGER DEFAULT 0
        );
        """
    )
    conn.commit()
    conn.close()


def seed_defaults():
    """Idempotent: populate a default idle office if no agents exist."""
    if get_agents():
        return False
    AGENTS = [
        ("ceo",  "ceo",  "Ada (CEO)",   0.50, 0.20),
        ("eng1", "engineer", "Milo",    0.20, 0.45),
        ("eng2", "engineer", "Zara",    0.35, 0.45),
        ("eng3", "engineer", "Kai",     0.20, 0.70),
        ("eng4", "engineer", "Nova",    0.35, 0.70),
        ("qa1",  "qa",   "Iris (QA)",   0.72, 0.50),
        ("qa2",  "qa",   "Rex (QA)",    0.72, 0.72),
    ]
    for agent_id, role, name, x, y in AGENTS:
        upsert_agent(agent_id, role, name, x, y, status="idle")
    for k in ["commits", "tests_passed", "tests_failed", "floors", "tasks_done"]:
        set_metric(k, 0)
    return True


# ---------- agents ----------

def upsert_agent(agent_id, role, name, desk_x, desk_y, status=None, current_task=None, model="", effort=""):
    conn = connect()
    conn.execute(
        """INSERT INTO agents (id, role, name, desk_x, desk_y, status, current_task, model, effort)
           VALUES (?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             role=excluded.role, name=excluded.name, desk_x=excluded.desk_x, desk_y=excluded.desk_y,
             status=COALESCE(excluded.status, agents.status),
             current_task=COALESCE(excluded.current_task, agents.current_task),
             model=excluded.model, effort=excluded.effort""",
        (agent_id, role, name, desk_x, desk_y, status, current_task, model, effort),
    )
    conn.commit()
    conn.close()


def set_agent_status(agent_id, status=None, current_task=None, model=None, effort=None):
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
        vals.append(agent_id)
        conn.execute(f"UPDATE agents SET {', '.join(fields)} WHERE id=?", vals)
        conn.commit()
    conn.close()


def get_agents():
    conn = connect()
    rows = conn.execute("SELECT * FROM agents").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_agent(agent_id):
    conn = connect()
    r = conn.execute("SELECT * FROM agents WHERE id=?", (agent_id,)).fetchone()
    conn.close()
    return dict(r) if r else None


# ---------- tasks ----------

def create_task(title, description="", assignee=None):
    conn = connect()
    cur = conn.execute(
        "INSERT INTO tasks (title, description, status, assignee, created_at, updated_at) VALUES (?,?,?,?,?,?)",
        (title, description, "todo", assignee, _now(), _now()),
    )
    conn.commit()
    tid = cur.lastrowid
    conn.close()
    return tid


def set_task_status(task_id, status, assignee=None):
    conn = connect()
    if assignee is not None:
        conn.execute("UPDATE tasks SET status=?, assignee=?, updated_at=? WHERE id=?", (status, assignee, _now(), task_id))
    else:
        conn.execute("UPDATE tasks SET status=?, updated_at=? WHERE id=?", (status, _now(), task_id))
    conn.commit()
    conn.close()


def get_tasks():
    conn = connect()
    rows = conn.execute("SELECT * FROM tasks ORDER BY id").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_next_todo():
    conn = connect()
    r = conn.execute("SELECT * FROM tasks WHERE status='todo' ORDER BY id LIMIT 1").fetchone()
    conn.close()
    return dict(r) if r else None


# ---------- events ----------

def add_event(agent_id, message, type="info"):
    conn = connect()
    conn.execute("INSERT INTO events (agent_id, type, message, ts) VALUES (?,?,?,?)",
                 (agent_id, type, message, _now()))
    conn.commit()
    conn.close()


def get_events(limit=100):
    conn = connect()
    rows = conn.execute("SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    conn.close()
    return [dict(r) for r in reversed(rows)]


# ---------- conversation ----------

def add_message(speaker, message):
    conn = connect()
    conn.execute("INSERT INTO conversation (speaker, message, ts) VALUES (?,?,?)", (speaker, message, _now()))
    conn.commit()
    conn.close()


def get_conversation(limit=200):
    conn = connect()
    rows = conn.execute("SELECT * FROM conversation ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    conn.close()
    return [dict(r) for r in reversed(rows)]


# ---------- metrics ----------

def set_metric(key, value):
    conn = connect()
    conn.execute("INSERT INTO metrics (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                 (key, value))
    conn.commit()
    conn.close()


def incr_metric(key, delta=1):
    conn = connect()
    conn.execute("INSERT INTO metrics (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=value+excluded.value",
                 (key, delta))
    conn.commit()
    conn.close()


def get_metrics():
    conn = connect()
    rows = conn.execute("SELECT * FROM metrics").fetchall()
    conn.close()
    return {r["key"]: r["value"] for r in rows}


# ---------- snapshot (single payload for websocket) ----------

def snapshot():
    return {
        "agents": get_agents(),
        "tasks": get_tasks(),
        "events": get_events(60),
        "conversation": get_conversation(200),
        "metrics": get_metrics(),
    }

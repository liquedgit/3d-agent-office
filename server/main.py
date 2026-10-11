"""FastAPI server: serves the office dashboard + streams live state over WebSocket."""
import asyncio
import os
import secrets
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

try:
    from server import db  # container: `uvicorn server.main:app` from /app
except ImportError:
    import db  # direct: `python main.py` from server/

WEB_DIR = Path(__file__).resolve().parent.parent / "web"

MAX_TEAM_PER_ROLE = 48  # sanity cap for /api/team/sync

OFFICE_PASSWORD = os.environ.get("OFFICE_PASSWORD", "")  # empty -> auth disabled
OFFICE_SESSION_COOKIE = "office_session"
SESSIONS: set[str] = set()  # in-memory session tokens

app = FastAPI(title="Agent Office")


def _authed(request) -> bool:
    if not OFFICE_PASSWORD:
        return True
    key = request.headers.get("x-office-key", "")
    if key and secrets.compare_digest(key, OFFICE_PASSWORD):
        return True
    return request.cookies.get(OFFICE_SESSION_COOKIE) in SESSIONS


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    path = request.url.path
    if path in ("/login", "/logout") or _authed(request):
        return await call_next(request)
    if path.startswith("/api/"):
        return JSONResponse({"detail": "unauthorized"}, status_code=401)
    return RedirectResponse("/login", status_code=307)


@app.get("/login")
def login_page():
    return FileResponse(WEB_DIR / "login.html")


@app.post("/login")
async def login_submit(payload: dict):
    # JSON body {"password": "..."}; avoids needing python-multipart.
    pw = payload.get("password")
    if OFFICE_PASSWORD and isinstance(pw, str) and secrets.compare_digest(pw, OFFICE_PASSWORD):
        token = secrets.token_urlsafe(32)
        SESSIONS.add(token)
        resp = JSONResponse({"ok": True})
        resp.set_cookie(OFFICE_SESSION_COOKIE, token, httponly=True, samesite="lax")
        return resp
    return JSONResponse({"ok": False, "error": "wrong password"}, status_code=401)


@app.post("/logout")
def logout(request: Request):
    SESSIONS.discard(request.cookies.get(OFFICE_SESSION_COOKIE, ""))
    resp = RedirectResponse("/login", status_code=307)
    resp.delete_cookie(OFFICE_SESSION_COOKIE)
    return resp


@app.on_event("startup")
def startup():
    db.init_db()
    db.seed_defaults()


# WebSocket clients -> the project id each one is subscribed to
CLIENTS: dict[WebSocket, str] = {}


def _send_all(clients, msg: dict):
    async def run():
        dead = []
        for ws in clients:
            try:
                await ws.send_json(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            CLIENTS.pop(ws, None)
    return run()


async def broadcast(snapshot: dict, project: str = db.DEFAULT_PROJECT):
    """Push a fresh snapshot to every browser watching `project`."""
    targets = [ws for ws, p in list(CLIENTS.items()) if p == project]
    await _send_all(targets, {"type": "snapshot", "project": project, "data": snapshot})


def _schedule(coro):
    try:
        asyncio.get_running_loop()
        asyncio.create_task(coro)
    except RuntimeError:
        coro.close()  # no running loop (e.g. called from a script)


def notify(project: str = db.DEFAULT_PROJECT):
    """Schedule a broadcast for any DB mutation. Safe to call from sync code."""
    _schedule(broadcast(db.snapshot(project), project))


def notify_projects():
    """Tell every connected browser the project list changed."""
    _schedule(_send_all(list(CLIENTS), {"type": "projects", "data": db.get_projects()}))


def resolve_project(payload: dict | None = None, project: str | None = None) -> str:
    """Project from the POST body, else the ?project= query param, else 'default'."""
    pid = (payload or {}).get("project") or project or db.DEFAULT_PROJECT
    if not db.project_exists(pid):
        raise HTTPException(status_code=404, detail=f"unknown project: {pid}")
    return pid


# ---- HTTP API (for the orchestrator to write state, and the UI to read it) ----
# Every endpoint accepts ?project=<id> (POSTs also accept a "project" body field).

@app.get("/api/projects")
def projects():
    return JSONResponse(db.get_projects())


@app.post("/api/projects")
async def post_project(payload: dict):
    """Create a project room: {name} -> {ok, id}."""
    name = str(payload.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    pid = db.create_project(name)
    notify_projects()
    return {"ok": True, "id": pid}


@app.get("/api/state")
def state(project: str | None = None):
    return JSONResponse(db.snapshot(resolve_project(project=project)))


@app.get("/api/agents")
def agents(project: str | None = None):
    return JSONResponse(db.get_agents(resolve_project(project=project)))


@app.get("/api/tasks")
def tasks(project: str | None = None):
    return JSONResponse(db.get_tasks(resolve_project(project=project)))


@app.get("/api/events")
def events(project: str | None = None):
    return JSONResponse(db.get_events(100, resolve_project(project=project)))


@app.get("/api/conversation")
def conversation(project: str | None = None):
    return JSONResponse(db.get_conversation(200, resolve_project(project=project)))


@app.get("/api/metrics")
def metrics(project: str | None = None):
    return JSONResponse(db.get_metrics(resolve_project(project=project)))


@app.post("/api/event")
async def post_event(payload: dict, project: str | None = None):
    """Orchestrator logs an event: {agent_id, message, type}."""
    pid = resolve_project(payload, project)
    db.add_event(payload.get("agent_id", "ceo"), payload.get("message", ""), payload.get("type", "info"), project=pid)
    notify(pid)
    return {"ok": True}


@app.post("/api/agent/status")
async def post_status(payload: dict, project: str | None = None):
    pid = resolve_project(payload, project)
    db.set_agent_status(
        payload["agent_id"],
        status=payload.get("status"),
        current_task=payload.get("current_task"),
        model=payload.get("model"),
        effort=payload.get("effort"),
        project=pid,
    )
    notify(pid)
    return {"ok": True}


@app.post("/api/task")
async def post_task(payload: dict, project: str | None = None):
    pid = resolve_project(payload, project)
    tid = db.create_task(payload["title"], payload.get("description", ""), payload.get("assignee"), project=pid,
                         depends_on=payload.get("depends_on"))
    notify(pid)
    return {"ok": True, "id": tid}


@app.get("/api/task/{task_id}")
def get_task(task_id: int, project: str | None = None):
    task = db.get_task(task_id, resolve_project(project=project))
    if task is None:
        raise HTTPException(status_code=404, detail=f"unknown task: {task_id}")
    return JSONResponse(task)


@app.post("/api/task/status")
async def post_task_status(payload: dict, project: str | None = None):
    """{task_id, status, assignee?} plus optional recovery counters {attempts, block_cycles, blocked_until}."""
    pid = resolve_project(payload, project)
    db.set_task_status(payload["task_id"], payload["status"], payload.get("assignee"), project=pid,
                       attempts=payload.get("attempts"), block_cycles=payload.get("block_cycles"),
                       blocked_until=payload.get("blocked_until"))
    notify(pid)
    return {"ok": True}


@app.post("/api/task/deps")
async def post_task_deps(payload: dict, project: str | None = None):
    """Replace a task's dependencies: {task_id, depends_on: [task ids in the same project]}."""
    pid = resolve_project(payload, project)
    db.set_task_deps(payload["task_id"], payload.get("depends_on") or [], project=pid)
    notify(pid)
    return {"ok": True}


@app.post("/api/team/sync")
async def post_team_sync(payload: dict, project: str | None = None):
    """Grow the project's team to {num_engineers, num_qas} -> {ok, added: [agent ids]}."""
    pid = resolve_project(payload, project)
    try:
        num_engineers, num_qas = int(payload["num_engineers"]), int(payload["num_qas"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(status_code=400, detail="num_engineers and num_qas are required integers")
    if not (0 <= num_engineers <= MAX_TEAM_PER_ROLE and 0 <= num_qas <= MAX_TEAM_PER_ROLE):
        raise HTTPException(status_code=400, detail=f"team counts must be 0..{MAX_TEAM_PER_ROLE}")
    added = db.sync_team(num_engineers, num_qas, project=pid)
    if added:
        notify(pid)
    return {"ok": True, "added": added}


@app.post("/api/metric")
async def post_metric(payload: dict, project: str | None = None):
    pid = resolve_project(payload, project)
    if payload.get("incr"):
        db.incr_metric(payload["key"], payload.get("delta", 1), project=pid)
    else:
        db.set_metric(payload["key"], payload.get("value", 0), project=pid)
    notify(pid)
    return {"ok": True}


@app.post("/api/message")
async def post_message(payload: dict, project: str | None = None):
    """User or CEO posts a chat message: {speaker, message}."""
    pid = resolve_project(payload, project)
    db.add_message(payload["speaker"], payload["message"], project=pid)
    notify(pid)
    return {"ok": True}


# ---- WebSocket ----

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket, project: str | None = None):
    """`/ws?project=<id>` streams that project's snapshots (unknown/absent -> 'default')."""
    if OFFICE_PASSWORD and ws.cookies.get(OFFICE_SESSION_COOKIE) not in SESSIONS:
        await ws.close(code=1008)
        return
    pid = project if project and db.project_exists(project) else db.DEFAULT_PROJECT
    await ws.accept()
    CLIENTS[ws] = pid
    try:
        await ws.send_json({"type": "snapshot", "project": pid, "data": db.snapshot(pid)})
        while True:
            await ws.receive_text()  # keep-alive; client sends periodic pings
    except WebSocketDisconnect:
        pass
    finally:
        CLIENTS.pop(ws, None)


# ---- Static frontend ----

@app.get("/")
async def index():
    return FileResponse(WEB_DIR / "index.html")


app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")


def main():
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8765)


if __name__ == "__main__":
    main()

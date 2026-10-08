"""FastAPI server: serves the office dashboard + streams live state over WebSocket."""
import asyncio
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

try:
    from server import db  # container: `uvicorn server.main:app` from /app
except ImportError:
    import db  # direct: `python main.py` from server/

WEB_DIR = Path(__file__).resolve().parent.parent / "web"

app = FastAPI(title="Agent Office")


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
    tid = db.create_task(payload["title"], payload.get("description", ""), payload.get("assignee"), project=pid)
    notify(pid)
    return {"ok": True, "id": tid}


@app.post("/api/task/status")
async def post_task_status(payload: dict, project: str | None = None):
    pid = resolve_project(payload, project)
    db.set_task_status(payload["task_id"], payload["status"], payload.get("assignee"), project=pid)
    notify(pid)
    return {"ok": True}


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

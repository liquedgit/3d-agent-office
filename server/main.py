"""FastAPI server: serves the office dashboard + streams live state over WebSocket."""
import asyncio
import contextlib
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
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


# WebSocket clients that should be notified of state changes
CLIENTS: set[WebSocket] = set()


async def broadcast(snapshot: dict):
    """Push a fresh snapshot to every connected browser."""
    dead = []
    for ws in list(CLIENTS):
        try:
            await ws.send_json({"type": "snapshot", "data": snapshot})
        except Exception:
            dead.append(ws)
    for ws in dead:
        CLIENTS.discard(ws)


def notify():
    """Schedule a broadcast for any DB mutation. Safe to call from sync code."""
    snap = db.snapshot()
    try:
        loop = asyncio.get_running_loop()
        asyncio.create_task(broadcast(snap))
    except RuntimeError:
        pass  # no running loop (e.g. called from a script)


# ---- HTTP API (for the orchestrator to write state, and the UI to read it) ----

@app.get("/api/state")
def state():
    return JSONResponse(db.snapshot())


@app.get("/api/agents")
def agents():
    return JSONResponse(db.get_agents())


@app.get("/api/tasks")
def tasks():
    return JSONResponse(db.get_tasks())


@app.get("/api/events")
def events():
    return JSONResponse(db.get_events(100))


@app.get("/api/conversation")
def conversation():
    return JSONResponse(db.get_conversation(200))


@app.post("/api/event")
async def post_event(payload: dict):
    """Orchestrator logs an event: {agent_id, message, type}."""
    db.add_event(payload.get("agent_id", "ceo"), payload.get("message", ""), payload.get("type", "info"))
    notify()
    return {"ok": True}


@app.post("/api/agent/status")
async def post_status(payload: dict):
    db.set_agent_status(
        payload["agent_id"],
        status=payload.get("status"),
        current_task=payload.get("current_task"),
        model=payload.get("model"),
        effort=payload.get("effort"),
    )
    notify()
    return {"ok": True}


@app.post("/api/task")
async def post_task(payload: dict):
    tid = db.create_task(payload["title"], payload.get("description", ""), payload.get("assignee"))
    notify()
    return {"ok": True, "id": tid}


@app.post("/api/task/status")
async def post_task_status(payload: dict):
    db.set_task_status(payload["task_id"], payload["status"], payload.get("assignee"))
    notify()
    return {"ok": True}


@app.post("/api/metric")
async def post_metric(payload: dict):
    if payload.get("incr"):
        db.incr_metric(payload["key"], payload.get("delta", 1))
    else:
        db.set_metric(payload["key"], payload.get("value", 0))
    notify()
    return {"ok": True}


@app.post("/api/message")
async def post_message(payload: dict):
    """User or CEO posts a chat message: {speaker, message}."""
    db.add_message(payload["speaker"], payload["message"])
    notify()
    return {"ok": True}


# ---- WebSocket ----

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    CLIENTS.add(ws)
    try:
        await ws.send_json({"type": "snapshot", "data": db.snapshot()})
        while True:
            await ws.receive_text()  # keep-alive; client sends periodic pings
    except WebSocketDisconnect:
        pass
    finally:
        CLIENTS.discard(ws)


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

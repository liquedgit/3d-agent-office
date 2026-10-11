# AUTH_SPEC.md — Password gate + Cloudflare exposure for Agent Office

Goal: put Agent Office behind a single-password gate, then expose it publicly via
Cloudflare Tunnel. Minimal, stdlib-only, no new Python dependencies.

## Current state
- `server/main.py`: FastAPI app. Serves `/` + `/static` (Three.js frontend), REST
  `/api/*`, and a WebSocket `/ws`. **No auth anywhere.**
- `orchestrator/orchestrator.py`: `Office` class talks to the API over plain HTTP
  using `urllib.request` (method `_req`, line ~129). Reads `base_url` from config.
- `orchestrator/config.json`: holds `base_url`, tiers, etc.
- `docker-compose.yml`: one service `office`, port 8765, mounts `./data` and `./web`.
- `requirements.txt`: only `fastapi` and `uvicorn[standard]`. **Do NOT add deps.**

## Auth model (single password, two entry paths)
One password gates everything. Two ways in:
1. **Browser** → login page sets a session cookie, then all HTTP + WS carry the cookie.
2. **API / orchestrator** → send header `X-Office-Key: <password>`.

When the password is empty, auth is **disabled** (current local-dev behaviour preserved).

## Server changes — `server/main.py`

### 1. Constants + session store (module level, near `MAX_TEAM_PER_ROLE`)
```python
import os, secrets
OFFICE_PASSWORD = os.environ.get("OFFICE_PASSWORD", "")
OFFICE_SESSION_COOKIE = "office_session"
SESSIONS: set[str] = set()   # in-memory session tokens
```

### 2. Auth helper
```python
def _authed(request) -> bool:
    if not OFFICE_PASSWORD:
        return True
    if request.headers.get("x-office-key") == OFFICE_PASSWORD:
        return True
    return request.cookies.get(OFFICE_SESSION_COOKIE) in SESSIONS
```

### 3. HTTP middleware (covers `/`, `/static/*`, `/api/*`)
Add with `@app.middleware("http")`. Order matters: register it so it wraps the whole
app including the `/static` mount. Logic:
- If `request.url.path == "/login"` or `request.url.path == "/logout"` → pass through.
- If `_authed(request)` → pass through.
- If path startswith `/api/` → `JSONResponse({"detail": "unauthorized"}, status_code=401)`.
- Else → `RedirectResponse("/login", status_code=307)`.

Use `from fastapi.responses import RedirectResponse` (add to existing import).

### 4. Login / logout endpoints
```python
@app.get("/login")
def login_page():
    return FileResponse(WEB_DIR / "login.html")

@app.post("/login")
async def login_submit(payload: dict):
    # JSON body {"password": "..."} (login.html posts JSON via fetch — avoids
    # needing python-multipart for form parsing).
    if payload.get("password") == OFFICE_PASSWORD and OFFICE_PASSWORD:
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
```
Import `Request` from fastapi if not already imported.

### 5. WebSocket gate
At the top of `ws_endpoint`, **before** `await ws.accept()`:
```python
if OFFICE_PASSWORD and ws.cookies.get(OFFICE_SESSION_COOKIE) not in SESSIONS:
    await ws.close(code=1008)
    return
```
(WebSocket carries the session cookie; the orchestrator never uses WS so it needs no
key path here.)

## New file — `web/login.html`
Self-contained, zero external assets, inline CSS + a few lines of vanilla JS.
Dark minimal theme matching the existing night-sky look. NO emoji, NO AI-looking
gradients/stock icons — clean, understated, geometric. Content:
- Centered card: small geometric wordmark/word "Agent Office", a password `<input
  type=password>`, a "Sign in" button, a thin error line (hidden until a failed attempt).
- JS: on submit, `fetch("/login", {method:"POST", headers:{"Content-Type":
  "application/json"}, body: JSON.stringify({password})})`. On `ok` → `location.href =
  "/"`. On 401 → show error, keep focus in input.
- Pressing Enter in the input triggers submit.

## Orchestrator changes — `orchestrator/orchestrator.py`
1. In `load_config`, after `base_url` handling, add:
   ```python
   cfg["office_key"] = os.environ.get("OFFICE_KEY", "") or cfg.get("office_key", "")
   ```
2. `Office.__init__(self, base_url, key="")`: store `self.key = key`.
3. In `_req`, build headers with the key when present:
   ```python
   headers = {"Content-Type": "application/json"}
   if self.key:
       headers["X-Office-Key"] = self.key
   req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
   ```
4. Update the `Office(...)` call site to `Office(cfg["base_url"], cfg.get("office_key", ""))`.

## `orchestrator/config.json`
Add `"office_key": ""` (empty default; the real value comes from the `OFFICE_KEY`
env var set in the systemd unit — never commit the secret).

## `docker-compose.yml`
Add to the `office` service environment:
```yaml
      - OFFICE_PASSWORD=${OFFICE_PASSWORD:-}
```

## `.gitignore` + `.env.example`
- Append `.env` to `.gitignore`.
- Add `.env.example` with:
  ```
  # single password for the Agent Office gate (browser + X-Office-Key header)
  OFFICE_PASSWORD=change-me
  ```

## Verification the implementer MUST run
1. `python -c "import ast; ast.parse(open('server/main.py').read())"` (and same for
   orchestrator.py) — syntax OK.
2. Start server with no `OFFICE_PASSWORD` set → `/` and `/api/projects` still work
   (auth disabled, no regression).
3. Start with `OFFICE_PASSWORD=testpass` → `GET /` redirects to `/login`; `GET
   /api/projects` returns 401; `GET /api/projects` with header `X-Office-Key: testpass`
   returns 200; `POST /login` with `{"password":"testpass"}` returns a `set-cookie`.

## Out of scope (do NOT touch)
- Cloudflare tunnel config, DNS, systemd units, `.env` secrets — handled separately by
  the operator, not this code change.
- Do not change tiers, models, budget, retry, team logic, or any DB code.
- Do not add dependencies to requirements.txt.

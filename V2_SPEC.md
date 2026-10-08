# Agent Office — v2 Features Spec (for Claude Code)

You are improving an existing, working 3D agent-office app. Read the current
code first, then implement the three features below WITHOUT breaking what works.

## Code locations (READ ALL before editing)
- `web/app.js`   — Three.js scene (1163 lines), WebSocket client, sidebar UI
- `web/index.html` — layout (header, canvas, sidebar tabs)
- `web/style.css`  — dark theme
- `server/db.py`   — SQLite store (tables: agents, tasks, events, conversation, metrics)
- `server/main.py` — FastAPI server, WebSocket `/ws`, REST `/api/*`
- `orchestrator/orchestrator.py` — host-side loop driving Claude Code CLI agents

## HARD CONSTRAINTS (do not break)
1. Three.js only, from vendored files `web/three.module.js` and `web/OrbitControls.js`
   via the existing import map. No CDN, no npm, no network, no new libraries.
2. Keep the WebSocket snapshot shape readable — but see Feature 2 for the required
   project-scoping change (this is an intentional, coordinated change).
3. Keep element IDs the frontend JS already depends on (see index.html).
4. Pure Canvas 2D for any textures; no external assets.
5. Keep the status→color semantics and event→bubble logic working.

---

## FEATURE 1 — Day / Night toggle (priority: polish)

The scene currently has fixed "moonlight" lighting (lines ~96–109 of app.js):
- `AmbientLight(0x8a96b8, 0.35)`, `HemisphereLight(0x9db8ff, 0x3a2a1c, 0.5)`,
  a cool key `DirectionalLight(0xcfe0ff, 1.15)` and warm fill `(0xffd2a0, 0.4)`.

Add a **Day/Night toggle** in the header (a button or switch). It should smoothly
cross-fade between two lighting moods:
- **Night** (current): cool moonlight, blue-ish ambience, windows glowing, lamps on.
- **Day**: warm bright sunlight, brighter ambience, warmer key light, sky texture in
  the windows becomes daytime, lamps dim/off.

Requirements:
- Animate the transition (lerp light colors/intensities over ~1.5s, not a hard cut).
- Also adjust `scene.background`, `scene.fog` color, and the window `skyTex`
  (re-draw or swap between two cached textures) to match day vs night.
- The toggle button must have a clear icon/state (🌙 / ☀️) and work without reload.
- Persist the choice in `localStorage` and restore on load.

## FEATURE 2 — Multi-project rooms (priority: core)

Currently there is ONE global office. Make it support MULTIPLE PROJECTS, where each
project is its own "room" with its own agents/tasks/events/conversation/metrics.

Design decisions (follow these):
- Add a `projects` table: `{ id TEXT PK, name TEXT, created_at INTEGER }`.
- Add a `project_id TEXT` column to `agents`, `tasks`, `events`, `conversation`,
  `metrics` tables. Default to a seeded project `default`.
- `metrics` currently uses `key TEXT PRIMARY KEY` — change PK to `(project_id, key)`.
- Seed a default project named "Default" so existing behavior keeps working.
- Add a **project switcher** in the header: a dropdown (or chips) listing all
  projects + a "New project" action (prompts for a name). Switching projects
  reloads the office state for that project and re-points the WebSocket.
- **WebSocket**: change `/ws` to accept a project via query string, e.g.
  `/ws?project=<id>` (and fall back to `default` if absent). The server must send
  only that project's snapshot, and broadcasts must fan out only to clients
  subscribed to the affected project.
- **REST API**: add project scoping. Accept an optional `project` field in each
  POST payload OR a `?project=` query param (default `default`). Every read
  (`/api/state`, `/api/agents`, etc.) must also accept the project param.
  Add `GET /api/projects` and `POST /api/projects` (create: `{name}` → returns id).
- Update `server/db.py` so every function is project-aware. Keep backward-compatible
  default args (`project="default"`) so the orchestrator keeps working unchanged.
- **Orchestrator**: leave it functionally untouched — it should keep using the
  default project unless told otherwise. Just verify it still runs after the change.

The goal: a user can have "CRM app" and "Discord bot" as two separate rooms, switch
between them in the dashboard, and each room has its own CEO/engineers/QA doing
different work, its own building, its own metrics.

## FEATURE 3 — Performance (priority: fix the lag)

The 3D scene feels laggy. Make it smooth, especially while orbiting/panning. The
user explicitly does NOT need everything — smoothness matters more than detail.
Apply targeted optimizations (measure with reasoning, not blind removal):

Likely culprits and suggested fixes (verify and apply the effective ones):
1. **`renderer.setPixelRatio(min(devicePixelRatio, 2))`** → cap at 1.5 or 1.25,
   and add a `devicePixelRatio` budget that re-clamps on resize.
2. **CanvasTexture redraws every frame**: `drawScreen` updates `stex.needsUpdate`
   per active agent ~every 0.12s (line ~766). Reduce the update frequency (e.g.
   every 0.25–0.3s) and skip entirely when the agent is idle and screen already off.
3. **Per-frame material updates**: `glow.material.color.set()`, `ring.material.opacity`,
   `shirt.emissive` etc. run every frame for every agent. Only update on change —
   cache last values and set only when the status/phase crosses a threshold, or
   reduce opacity pulsing to every other frame.
4. **Shadows**: `key.shadow.mapSize 2048` + 4 point lights with shadows is heavy.
   Lower the key shadow map to 1024, and disable shadows on small props (mugs,
   books, small plant leaves) — keep shadows only on characters, desks, walls.
5. **Point lights**: 4 `PointLight` (intensity 45, distance 22) each are costly.
   Reduce to 2 point lights, or lower intensity/distance, or switch lamps to
   emissive-only (no real light) with a fake glow — since day/night now drives
   ambience, lamps can be cheaper.
6. **Raycaster on pointermove** is throttled to 60ms already — keep, but also skip
   the raycast while the pointer is down (dragging).
7. **Antialias + PCFSoftShadowMap**: consider `renderer.setPixelRatio(1)` fallback
   if the device has high DPI; and switch shadow type to `PCFShadowMap` (cheaper).
8. **`updateBubbles`** projects vectors + sets style every frame per bubble — fine
   (few bubbles), but guard against DOM writes when nothing changed.

Also add a lightweight **frame-time / FPS monitor** is NOT required — skip it. The
goal is silent smoothness.

## VERIFY (after implementing, before reporting)
1. `python3 -c "import ast; ast.parse(open('server/db.py').read())"` and same for
   main.py and orchestrator.py — no syntax errors.
2. The office server still starts (if you can, `cd server && python3 main.py` is
   not required — but at least eyeball the import/project changes for correctness).
3. Frontend: no JS syntax errors; every getElementById resolves; the import map
   still resolves three.
4. Day/night toggle and project switcher are wired into the DOM (header) and
   connected to real handlers.
5. Report: a concise summary of each feature, plus any file you changed and why.

## REPORT BACK
Summarize: (a) what you changed per feature, (b) the exact perf optimizations you
applied and why, (c) any assumptions or risks, (d) anything you could NOT verify.

# Agent Office — 3D UI Spec (Three.js)

Rebuild the frontend as a **3D office scene in Three.js**, taking the *layout and
feature concept* from the reference repo (pixel-art agents in an office with
desks, task board, log, chat, click-to-follow camera) but rendering it as a real
3D low-poly scene — NOT pixel art.

## Reference (read for concept, DO NOT copy pixel-art rendering)
`/tmp/agent-office-ref/pixel-agents-repo/` — a "self-growing AI team in a virtual
office". Key concepts to keep:
- Agents walk to desks to work, approach each other to talk
- Click an agent to smoothly follow them with the camera
- Emote/action bubbles above agents (💻 💬 😌 🔧 🚶 💡)
- Overlay panels: Chat, TaskBoard, SystemLog, plus a stats/metrics bar
- A living, self-organizing team feel

## Where the code lives
`/home/liqued/agent-office/web/`

## ALREADY VENDORED (use these, do NOT download anything)
- `/home/liqued/agent-office/web/three.module.js`  (Three.js 0.160.0, ES module)
- `/home/liqued/agent-office/web/OrbitControls.js` (imports from 'three')

## Current files to REPLACE entirely
- `web/index.html`
- `web/style.css`
- `web/app.js`

## HARD CONSTRAINTS (do NOT break any of these)
1. **Three.js only, from the vendored files.** No CDN, no npm, no network. It must
   run fully offline inside the Docker container. Use an import map:
   ```html
   <script type="importmap">
     { "imports": { "three": "/static/three.module.js",
                    "three/addons/": "/static/" } }
   </script>
   ```
   Then in app.js (as `<script type="module">`):
   `import * as THREE from 'three';` and
   `import { OrbitControls } from 'three/addons/OrbitControls.js';`
2. **Keep the WebSocket contract IDENTICAL.** The server sends snapshots of shape
   `{agents, tasks, events, conversation, metrics}`. `ingest(snapshot)` is the
   entry point. Do NOT change the server API or field names.
   - Agent: `{id, role (ceo|engineer|qa), name, desk_x, desk_y, status, current_task, model, effort}`
   - Status: `idle|thinking|working|testing|blocked|waiting|done`
   - Task: `{id, title, description, status (todo|in_progress|review|done), assignee}`
   - Event: `{id, agent_id, type (info|success|error|think|talk), message, ts}`
   - Conversation: `{id, speaker (user|ceo), message, ts}`
   - Metrics: `{commits, tests_passed, tests_failed, floors, tasks_done}`
3. **Keep these element IDs** (the JS depends on them; you may restyle but not
   rename): `office-canvas` (the render target — replace with a Three.js renderer
   attached to a container `#office`), `messages`, `chatform`, `chatinput`,
   `chatsend`, `log`, `tasklist`, `metrics`, and the tab buttons with `data-panel`.
   The chat input posts to `/api/message` with `{speaker:"user", message}`.
4. **Keep the status→color semantics** (idle gray, thinking amber, working blue,
   testing purple, blocked red, waiting amber, done green) so agent state is
   readable at a glance.
5. **Keep the event→bubble + particle logic**: info/success/error/think events
   spawn a speech bubble above the agent; success = green burst, error = red.
6. **60fps** via requestAnimationFrame; keep geometry cheap (low-poly).

## WHAT TO BUILD (3D scene)

### Scene & environment
- A **top-down-ish, slightly angled perspective camera** (OrbitControls enabled:
  rotate, zoom, pan — with a comfortable default angle like a 45° three-quarter
  view so you can see the office).
- **Floor**: a large plane with a subtle grid or wood/office texture made from
  simple materials (MeshStandardMaterial with a canvas-generated or procedural
  pattern — no external textures).
- **Walls** (2–3 sides, so the camera can see in): with **windows** (emissive
  panes) and a couple of **plants** and **lamps** for ambiance.
- **Lighting**: ambient + a couple of directional/point lights for soft shadows
  (enable renderer.shadowMap if cheap enough). The scene should look polished,
  not flat — use MeshStandardMaterial with warm/cool light contrast.

### Desks (per agent)
Each agent has a **3D desk + chair** at its `(desk_x, desk_y)` position (map the
normalized 0..1 coords onto the floor plane, spread out with padding). Desk =
tabletop box + legs + a monitor with an emissive screen. Screen glows/color
changes with status (blue when working/testing/thinking, off when idle, red
when blocked). A subtle ring or spotlight under the desk shows status color.

### Characters (the stars)
Low-poly 3D people: rounded body, head, simple arms/legs (capsule/box primitives
are fine), a role "hat" or accent (CEO = amber/gold, engineer = blue, QA = purple).
Animate by status:
- `idle` / `waiting`: gentle bob / sway, occasionally look around
- `working`: sit at desk, arms bob as if typing, monitor active
- `testing`: sit, hands move, screen flashes test patterns
- `thinking`: stand, hand on chin, a 💭/❓ floating above, slight sway
- `blocked`: sit slumped, ⚠️/⛔ floating above, red glow
- `done`: stand, arms up briefly, ✅ above
- Walking: when an agent changes desk/claims a task, smoothly lerp its position
  and animate a simple walk (legs/arms swing). Agents should *walk to their desk*
  when they become active, and stand near it when idle.
Use requestAnimationFrame to interpolate positions (store target + current and
lerp toward target).

### Speech bubbles
When an event fires for an agent, show a floating bubble (HTML overlay positioned
via projection, OR a THREE.Sprite with canvas-drawn text — pick whichever is
simpler and reliable). Bubble auto-fades after ~4.5s. Color-coded by event type.

### Building (progress visual)
A 3D building in a corner of the office that **grows a floor** as `metrics.floors`
increases. Each floor = a box; when floors increments, animate a new box sliding
into place with a small confetti burst. If floors==0, show an empty construction
plot (a flat outline + a little crane or "build site" sign).

### Overlay chrome (HTML/CSS — make it polished, Linear/Stripe-grade)
- **Header**: app title + live status dot + a small legend of agent roles.
- **Right sidebar** with tabs: 💬 CEO chat, 📜 Activity log, 🗂 Tasks, 📊 Stats.
  This overlay must look like a premium dark product UI (layered surfaces, soft
  borders, good typography, avatars in chat, colored badges for task/status).
- **Stats bar or panel**: floors, commits, tests passed/failed, tasks done.
- The whole thing uses the existing dark palette but refined: deeper backgrounds,
  subtle gradients, rounded corners, consistent spacing.

### Camera features
- OrbitControls (rotate/zoom/pan).
- **Click an agent** → smoothly move the camera target to follow them (like the
  reference's focus mode). Click empty space or a "reset view" button to un-follow.
  Use raycasting against the agent meshes.

## DELIVERABLE
Rewrite `web/index.html`, `web/style.css`, and `web/app.js`. Keep everything
self-contained in these three files (plus the vendored three.js files, which you
must reference via import map and not modify).

## VERIFY (after writing)
1. No JS syntax errors (the module loads cleanly — check for import errors).
2. Every `getElementById` resolves to an existing ID in index.html.
3. The WebSocket snapshot fields are read correctly (no field renames).
4. The scene renders (canvas paints; a simple Three.js scene is visible).
5. Report a concise summary of what you built and any assumptions.

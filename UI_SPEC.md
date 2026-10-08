# Agent Office — UI Redesign Spec

The current frontend (`/home/liqued/agent-office/web/`) is a crude functional
skeleton. The user wants it to look genuinely good — a polished, living,
"mini people working in an office" animation, not a flat toy.

## What exists (read these first)
- `web/index.html` — layout: header + canvas (#office) + sidebar (CEO chat /
  Activity / Tasks / Stats tabs)
- `web/style.css` — dark theme CSS vars
- `web/app.js` — Canvas 2D renderer, WebSocket client, sidebar renderers

## What's wrong now (fix ALL of these)
1. **Characters are crude ellipses.** Flat color ellipse body + circle head.
   Needs real character design: rounded body with gradient shading, visible
   arms that swing when walking/typing, subtle face, nicer role hats.
2. **No office environment.** Just a canvas with desks floating on a flat color.
   Add: a floor with perspective, wall, windows, plants, lamps, and ambient
   depth so it reads as an actual office.
3. **Flat, lifeless palette.** Colors are okay-ish but there's no lighting,
   no gradient depth, no shadow quality.
4. **Building is boring rectangles.** Make the growing building look like an
   actual structure — floors with depth, a crane when under construction,
   a little celebration when a floor is added.
5. **Animation is basic bob/hammer.** Add: walking animation (legs/arms move),
   typing animation (hands move over keyboard), thinking pose, coffee sip
   while idle, walking from desk to desk when claiming tasks.
6. **Sidebar is plain.** Improve typography, spacing, avatars next to messages,
   nicer badges, subtle dividers.

## Target aesthetic
- **Premium dark "product" look** — think Linear/Stripe/Vercel dark UI.
- Cohesive color system (keep the dark base but enrich it: layered surfaces,
  soft glows, gradient accents).
- The office scene should feel ALIVE and slightly playful, but the chrome
  (header, sidebar, tabs) should feel like a polished SaaS product.

## Hard constraints (do NOT break)
- **Pure Canvas 2D + vanilla JS/CSS.** No external libraries, no CDN, no npm.
  Must run fully offline inside the Docker container. (PixiJS/Phaser/Three
  are NOT installed — do not add them.)
- **Keep the WebSocket contract identical.** `ingest(snapshot)` is the entry
  point; snapshot shape = {agents, tasks, events, conversation, metrics}.
  Do not change the server API or the field names. Agents have: id, role
  (ceo|engineer|qa), name, desk_x, desk_y, status (idle|thinking|working|
  testing|blocked|waiting|done), current_task, model, effort.
- Keep the element IDs the JS depends on: `office-canvas`, `messages`,
  `chatform`, `chatinput`, `chatsend`, `log`, `tasklist`, `metrics`, and the
  tab buttons with `data-panel`.
- Status→color/emoji mapping and event→speech-bubble logic must keep working.

## Deliverable
Rewrite `web/index.html`, `web/style.css`, and `web/app.js` with a genuinely
polished look and fluid character/environment animation. Keep it performant
(runs at 60fps via requestAnimationFrame; cap expensive effects).

## Verify
After writing, sanity-check: no JS syntax errors, all getElementById calls
resolve to existing IDs, the WebSocket message shape is unchanged, and the
canvas paints >0 pixels on load.

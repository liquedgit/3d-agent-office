# 3d-agent-office

A self-growing AI team in a 3D virtual office — powered by Claude Code.

Watch AI agents (CEO, engineers, QA) walk to desks, think, collaborate, write code, run tests, and grow their team — rendered in real-time 3D with Three.js.

## Architecture

```
[Web Dashboard (Three.js)] ←WebSocket→ [Office server :8765 (FastAPI + SQLite, Docker)]
                                        ↑ HTTP POST
                              [Orchestrator (host) → Claude Code CLI agents]
```

- **CEO agent** — chats with you, plans the product, breaks work into tasks
- **Engineer agents** — implement tasks, commit to the workspace repo
- **QA agents** — run tests, report pass/fail

## Model & effort tiering (token frugality)

| Role | model | effort |
|------|-------|--------|
| CEO chat | sonnet | medium |
| CEO planning | opus | high |
| Engineer (standard) | sonnet | medium |
| Engineer (trivial) | haiku | low |
| QA tests | haiku | low |
| QA review | sonnet | medium |
| Mechanical | haiku | low |

Hard rules: opus is the max model, effort capped at low/medium/high, no
`--fallback-model`, every run has `--max-turns` and `--max-budget-usd`.

## Run

```bash
docker compose up -d          # office server on http://127.0.0.1:8765
cd orchestrator && ./run.sh   # swarm (add --once for a single cycle)
```

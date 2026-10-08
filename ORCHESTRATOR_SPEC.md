# Agent Office — Orchestrator Spec

The orchestrator is the "brains" that drives the swarm. It runs on the HOST
(outside Docker), talks to the running office server over HTTP
(`http://127.0.0.1:8765`), and shells out to the Claude Code CLI to do real work.

## Architecture

```
[Web Dashboard] ←WebSocket→ [Office server :8765 (Docker)] ←HTTP POST→ [Orchestrator (host)]
                                                                        │
                                                                        ├─ CEO agent (Claude Code)
                                                                        ├─ Engineer agents (Claude Code, per-task)
                                                                        └─ QA agent (Claude Code)
```

The orchestrator is a **single long-running Python process** on the host that:

1. **Polls the office server** for new user messages (`GET /api/conversation`).
2. When the user posts a message, runs the **CEO agent** (Claude Code) to respond
   and decide whether to plan/build/delegate.
3. Writes the CEO's reply and any plan/tasks/events back to the server via the
   HTTP API, which broadcasts to the dashboard.
4. When tasks exist, assigns them to idle engineers and runs them as separate
   Claude Code processes.
5. Runs QA on completed work.
6. Pings the user on Discord when the CEO needs a decision.

## Office server API (already built, verified working)

Base URL: `http://127.0.0.1:8765`

- `GET  /api/state`        → full snapshot {agents, tasks, events, conversation, metrics}
- `GET  /api/conversation` → [{id, speaker, message, ts}]
- `POST /api/message`      → {speaker: "user"|"ceo", message}       (adds a chat line)
- `POST /api/event`        → {agent_id, message, type}              (logs activity; type: info|success|error|think|talk)
- `POST /api/agent/status` → {agent_id, status, current_task, model, effort}
- `POST /api/task`         → {title, description, assignee}
- `POST /api/task/status`  → {task_id, status, assignee}
- `POST /api/metric`       → {key, value} or {key, incr: true, delta: 1}

Agent IDs (already seeded): `ceo`, `eng1..eng4`, `qa1`, `qa2`
Statuses: `idle | thinking | working | testing | blocked | waiting | done`
Task statuses: `todo | in_progress | review | done`

## MODEL + EFFORT TIERING (HARD REQUIREMENT — token frugality)

This is a hard spec. Every Claude Code invocation MUST pass explicit model and
effort flags, and MUST NOT exceed these tiers.

| Role | model flag | effort flag | notes |
|------|-----------|-------------|-------|
| CEO — chatting/responding to user | `--model sonnet` | `--effort medium` | |
| CEO — planning / architecture / task breakdown | `--model opus` | `--effort high` | only when actually architecting |
| Engineer — standard coding | `--model sonnet` | `--effort medium` | |
| Engineer — trivial edits | `--model haiku` | `--effort low` | |
| QA — run tests + summarize | `--model haiku` | `--effort low` | |
| QA — code review | `--model sonnet` | `--effort medium` | |
| Mechanical (commit msgs, triage, file ops) | `--model haiku` | `--effort low` | |

**Absolute rules:**
- `opus` is the MAXIMUM model. Never anything above it.
- Effort is `low|medium|high` ONLY. **Never `xhigh` or `max`** by default.
- **NEVER pass `--fallback-model`** (no silent model switching).
- Every invocation passes `--max-turns` (≤ 15) and `--max-budget-usd` (configurable,
  default 2.00 per run). This is the runaway-cost kill switch.
- Always use `-p` (print mode), never interactive, never `--dangerously-skip-permissions`.

## CLAUDE CODE INVOCATION PATTERN

```
claude -p "<prompt>" \
  --model <tier-model> \
  --effort <tier-effort> \
  --max-turns <n> \
  --max-budget-usd <amt> \
  --allowedTools "Read,Edit,Write,Bash" \
  --output-format json
```
Run with `cwd` = the workspace repo (`~/agent-office/workspace`).

## WORKSPACE

The swarm builds the user's app in `~/agent-office/workspace/` (a git repo).
The CEO reads/writes `spec.md` and `BACKLOG.md` there. Every engineer commit
increments the `commits` metric and, on merge of a completed task, the `floors`
metric. QA increments `tests_passed` / `tests_failed`.

## CEO LOOP (the important part)

The CEO is **idle by default**. It only acts when the user speaks. On a new user
message:

1. Set `ceo` status → `thinking`, log event "CEO thinking…".
2. Run CEO (sonnet/medium). Prompt includes: the full recent conversation, the
   current `spec.md` + `BACKLOG.md` (if any), and the instruction:
   - Respond conversationally to the user.
   - If the user's request is vague, ASK clarifying questions (this is the
     "talking with planning" the user wants — converge on a concrete idea).
   - Only when the idea is concrete, write `spec.md`, break it into tasks in
     `BACKLOG.md`, create tasks in the office DB, and delegate.
   - If a genuine decision can't be made alone, escalate to the user (via the
     Discord bridge + a chat message).
3. Write the CEO reply back via `POST /api/message` (speaker="ceo").
4. Set `ceo` status → `idle` (or `done` if it just delegated).

## ENGINEER LOOP

Poll for `todo` tasks. For each, pick an idle engineer, set `working` + assign,
run the engineer (sonnet/medium) in the workspace to implement the task, commit.
On success → task `done`, metric `commits`+1, `floors`+1, log success event. On
failure → task back to `todo` (or `blocked`), log error.

## QA LOOP

When a task hits `done`, run QA (haiku/low) to run the tests and summarize.
Increment `tests_passed`/`tests_failed`. If failures → task back to `review`/`todo`,
log error event; else log success.

## DISCORD BRIDGE

When the CEO needs the user (asking a clarifying question or escalating a
decision), the orchestrator should ALSO deliver that message to the user on
Discord so they don't have to watch the dashboard. Implement this as a hook: the
orchestrator writes the message to a file or calls a helper script
`discord_notify.sh` (which you'll stub — the actual Discord send is handled by
the Hermes layer). The orchestrator just needs to emit a clear, machine-readable
signal (e.g. append a JSON line to `~/agent-office/pending_discord.jsonl`).

## DELIVERABLE

A single Python program `~/agent-office/orchestrator/orchestrator.py` plus a
`config.json` (model/effort tiers, budget caps, poll interval, base URL) and a
`run.sh` launcher. It must:
- run standalone (`python3 orchestrator.py`)
- never need root
- be restartable (persist nothing in memory; derive state from the server DB)
- log clearly to stdout
- be safe to kill and restart at any time

## VERIFICATION

After building, prove it works by:
1. `python3 orchestrator.py --once` (single poll cycle) exits cleanly.
2. A user message "hi" produces a CEO reply in `/api/conversation`.
3. Sanity-check the model/effort flags in the code match the tier table exactly.

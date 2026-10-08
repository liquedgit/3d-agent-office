#!/usr/bin/env python3
"""Agent Office orchestrator — drives the CEO / engineer / QA swarm.

Runs on the host, talks to the office server over HTTP, and shells out to the
Claude Code CLI (print mode) for every agent run. All durable state lives in the
server DB and the workspace git repo; the only in-memory state is the set of
runs currently in flight, so the process is safe to kill and restart.

Task lifecycle (all derived from the server DB):
    todo --engineer--> in_progress --commit--> review --QA pass+merge--> done
                                       +--fail--> todo (blocked after N failures)
"""
import argparse
import concurrent.futures as cf
import fcntl
import json
import os
import random
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Hard ceilings from the spec. Config is validated against these at startup.
ALLOWED_MODELS = ("haiku", "sonnet", "opus")  # opus is the maximum
ALLOWED_EFFORTS = ("low", "medium", "high")   # never xhigh / max
MAX_TURNS_CEILING = 15
REQUIRED_TIERS = ("ceo_chat", "ceo_plan", "eng_standard", "eng_trivial",
                  "qa_tests", "qa_review", "mechanical")

FULL_TOOLS = "Read,Edit,Write,Bash"
MAX_TASK_ATTEMPTS = 3          # soft guard against burning budget on a hopeless task
RECENT_MESSAGES = 30
MAX_DOC_CHARS = 20000

DEFAULT_PROJECT = "default"
PROJECT_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")  # ids double as workspace dir names
DEFAULT_CEO_NAME = "Suwandi"
GIT_IDENTITY = ("-c", "user.name=Michael Bryan Chandra",
                "-c", "user.email=89082382+liquedgit@users.noreply.github.com")


# Transient-limit retry tuning; every key is optional in config.json.
LIMIT_RETRY_DEFAULTS = {
    "limit_retries": 5,            # max retry attempts
    "limit_retry_base_sec": 20,    # first backoff
    "limit_retry_max_sec": 300,    # cap per backoff
    "limit_retry_total_sec": 1800, # hard cap on total wait across retries
}
RETRYABLE_SUBTYPES = {"rate_limit", "billing_error", "error_max_turns", "error_budget"}
LIMIT_RE = re.compile(
    r"rate.?limit|usage limit|too many requests|\b429\b|overloaded|subscription|"
    r"weekly limit|daily limit|monthly limit|billing|plan limit|quota|max.*turns|budget exceeded",
    re.I)


def is_retryable_limit(data, err, out):
    """True for transient 'try again later' limit failures, False for real failures."""
    if isinstance(data, dict):
        if data.get("subtype") in RETRYABLE_SUBTYPES:
            return True
        # Parsed JSON: don't scan the model's own result text, it may quote anything.
        text = f"{err or ''} {data.get('error') or ''}"
    else:
        text = f"{err or ''} {out or ''}"
    return bool(LIMIT_RE.search(text))


def log(msg):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


# ---------------------------------------------------------------- config

def load_config(path):
    with open(path) as f:
        cfg = json.load(f)
    for key in ("workspace", "pending_discord_file"):
        cfg[key] = str(Path(os.path.expanduser(cfg[key])))
    cfg["base_url"] = cfg["base_url"].rstrip("/")

    tiers = cfg.get("tiers", {})
    for name in REQUIRED_TIERS:
        if name not in tiers:
            raise SystemExit(f"config: missing tier '{name}'")
    for name, tier in tiers.items():
        if tier.get("model") not in ALLOWED_MODELS:
            raise SystemExit(f"config: tier '{name}' model {tier.get('model')!r} not in {ALLOWED_MODELS}")
        if tier.get("effort") not in ALLOWED_EFFORTS:
            raise SystemExit(f"config: tier '{name}' effort {tier.get('effort')!r} not in {ALLOWED_EFFORTS}")
    if not 1 <= int(cfg["max_turns"]) <= MAX_TURNS_CEILING:
        raise SystemExit(f"config: max_turns must be 1..{MAX_TURNS_CEILING}")
    if float(cfg["max_budget_usd"]) <= 0:
        raise SystemExit("config: max_budget_usd must be > 0")
    for key, default in LIMIT_RETRY_DEFAULTS.items():
        cfg[key] = type(default)(cfg.get(key, default))
    return cfg


# ---------------------------------------------------------------- office server API

class Office:
    def __init__(self, base_url):
        self.base = base_url

    def _req(self, method, path, payload=None):
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read() or b"null")

    def get(self, path):
        return self._req("GET", path)

    def post(self, path, payload):
        try:
            return self._req("POST", path, payload)
        except (urllib.error.URLError, OSError) as e:
            log(f"WARN POST {path} failed: {e}")
            return None

    def projects(self):
        """All project rooms: [{id, name, created_at}]."""
        return self.get("/api/projects") or []

    def state(self, project=DEFAULT_PROJECT):
        return self.get(f"/api/state?project={urllib.parse.quote(project, safe='')}")

    def message(self, speaker, message, project=DEFAULT_PROJECT):
        return self.post("/api/message", {"speaker": speaker, "message": message, "project": project})

    def event(self, agent_id, message, type="info", project=DEFAULT_PROJECT):
        log(f"[{project}/{agent_id}] {message}")
        return self.post("/api/event", {"agent_id": agent_id, "message": message, "type": type,
                                        "project": project})

    def agent(self, agent_id, status, current_task=None, model=None, effort=None, project=DEFAULT_PROJECT):
        return self.post("/api/agent/status", {"agent_id": agent_id, "status": status,
                                               "current_task": current_task,
                                               "model": model, "effort": effort, "project": project})

    def create_task(self, title, description, assignee=None, project=DEFAULT_PROJECT):
        r = self.post("/api/task", {"title": title, "description": description, "assignee": assignee,
                                    "project": project})
        return r.get("id") if r else None

    def task_status(self, task_id, status, assignee=None, project=DEFAULT_PROJECT):
        return self.post("/api/task/status", {"task_id": task_id, "status": status, "assignee": assignee,
                                              "project": project})

    def incr(self, key, delta=1, project=DEFAULT_PROJECT):
        return self.post("/api/metric", {"key": key, "incr": True, "delta": delta, "project": project})


# ---------------------------------------------------------------- Claude Code runner

class Claude:
    """Every invocation goes through run(): explicit tier model/effort, turn and
    budget caps, print mode, JSON output. No --fallback-model, ever."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.procs = set()
        self.lock = threading.Lock()

    def build_cmd(self, tier_name, tools):
        tier = self.cfg["tiers"][tier_name]
        assert tier["model"] in ALLOWED_MODELS and tier["effort"] in ALLOWED_EFFORTS
        return [
            self.cfg["claude_bin"], "-p",
            "--model", tier["model"],
            "--effort", tier["effort"],
            "--max-turns", str(int(self.cfg["max_turns"])),
            "--max-budget-usd", f"{float(self.cfg['max_budget_usd']):.2f}",
            "--allowedTools", tools,
            "--output-format", "json",
        ]

    def run(self, tier_name, prompt, cwd, tools=FULL_TOOLS):
        """Returns (ok, result_text, info). Transient limit failures are retried with
        exponential backoff + jitter; this runs in a worker thread so sleeping is fine."""
        retries = int(self.cfg.get("limit_retries", LIMIT_RETRY_DEFAULTS["limit_retries"]))
        base = float(self.cfg.get("limit_retry_base_sec", LIMIT_RETRY_DEFAULTS["limit_retry_base_sec"]))
        cap = float(self.cfg.get("limit_retry_max_sec", LIMIT_RETRY_DEFAULTS["limit_retry_max_sec"]))
        total_cap = float(self.cfg.get("limit_retry_total_sec", LIMIT_RETRY_DEFAULTS["limit_retry_total_sec"]))
        retried, waited = 0, 0.0
        while True:
            ok, text, info, limited = self._run_once(tier_name, prompt, cwd, tools)
            info["retried"], info["waited_sec"] = retried, round(waited)
            if ok or not limited or retried >= retries:
                return ok, text, info
            delay = min(base * 2 ** retried, cap) * random.uniform(0.8, 1.2)
            if waited + delay > total_cap:
                log(f"limit retry budget exhausted ({round(waited)}s waited of {round(total_cap)}s)")
                return ok, text, info
            retried += 1
            log(f"rate-limit hit, waiting {round(delay)}s (retry {retried}/{retries}) tier={tier_name}")
            time.sleep(delay)
            waited += delay

    def _run_once(self, tier_name, prompt, cwd, tools):
        """One CLI invocation. Returns (ok, result_text, info, limited). Prompt goes
        over stdin so it can't be swallowed by the variadic --allowedTools flag or hit
        argv size limits."""
        cmd = self.build_cmd(tier_name, tools)
        tier = self.cfg["tiers"][tier_name]
        log(f"claude run tier={tier_name} model={tier['model']} effort={tier['effort']} cwd={cwd}")
        try:
            proc = subprocess.Popen(cmd, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, text=True)
        except OSError as e:
            return False, "", {"error": f"failed to start claude: {e}"}, False
        with self.lock:
            self.procs.add(proc)
        try:
            out, err = proc.communicate(prompt, timeout=self.cfg["run_timeout_sec"])
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()
            return False, "", {"error": f"timed out after {self.cfg['run_timeout_sec']}s"}, False
        finally:
            with self.lock:
                self.procs.discard(proc)

        try:
            data = json.loads(out)
        except json.JSONDecodeError:
            return (False, out.strip(), {"error": (err or out).strip()[-500:] or f"exit {proc.returncode}"},
                    is_retryable_limit(None, err, out))
        info = {
            "cost_usd": data.get("total_cost_usd"),
            "turns": data.get("num_turns"),
            "subtype": data.get("subtype"),
        }
        ok = proc.returncode == 0 and not data.get("is_error") and data.get("subtype") == "success"
        if not ok:
            info["error"] = data.get("subtype") or (err.strip()[-500:] if err else f"exit {proc.returncode}")
        return ok, (data.get("result") or "").strip(), info, (not ok and is_retryable_limit(data, err, out))

    def terminate_all(self):
        with self.lock:
            procs = list(self.procs)
        for p in procs:
            try:
                p.terminate()
            except OSError:
                pass


def extract_json(text):
    """Pull the last JSON object out of an agent's reply (fenced block preferred)."""
    blocks = re.findall(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    candidates = list(reversed(blocks))
    start = text.rfind("\n{")
    if start != -1:
        candidates.append(text[start + 1:])
    if text.lstrip().startswith("{"):
        candidates.append(text.strip())
    for c in candidates:
        try:
            obj = json.loads(c)
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            continue
    return None


def strip_json(text):
    return re.sub(r"```(?:json)?\s*\{.*?\}\s*```", "", text, flags=re.S).strip()


# ---------------------------------------------------------------- git helpers

class Git:
    """One project's repo at <workspace>/<project-id>/, task worktrees under its worktrees/."""

    def __init__(self, workspace):
        self.ws = Path(workspace)
        self.worktrees = self.ws / "worktrees"
        self.lock = threading.Lock()  # serialises operations on the main checkout

    def run(self, *args, cwd=None, check=True):
        r = subprocess.run(["git", *args], cwd=cwd or self.ws, capture_output=True, text=True)
        if check and r.returncode != 0:
            raise RuntimeError(f"git {' '.join(args)}: {r.stderr.strip() or r.stdout.strip()}")
        return r

    def ensure_repo(self):
        self.ws.mkdir(parents=True, exist_ok=True)
        if not (self.ws / ".git").exists():
            self.run("init")
        # Worktrees live inside the repo dir: keep them out of the main checkout's `add -A`.
        exclude = self.ws / ".git" / "info" / "exclude"
        if "/worktrees/" not in (exclude.read_text() if exclude.exists() else "").splitlines():
            exclude.parent.mkdir(parents=True, exist_ok=True)
            with open(exclude, "a") as f:
                f.write("/worktrees/\n")
        if self.run("rev-parse", "--verify", "HEAD", check=False).returncode != 0:
            self.run(*GIT_IDENTITY, "commit", "--allow-empty", "-m", "Initial commit")

    def main_branch(self):
        return self.run("symbolic-ref", "--short", "HEAD").stdout.strip()

    def commit_all(self, message, cwd=None):
        """Commit any uncommitted changes. Returns True if a commit was made."""
        cwd = cwd or self.ws
        if not self.run("status", "--porcelain", cwd=cwd).stdout.strip():
            return False
        self.run("add", "-A", cwd=cwd)
        self.run(*GIT_IDENTITY, "commit", "-m", message, cwd=cwd)
        return True

    def head(self, cwd):
        return self.run("rev-parse", "HEAD", cwd=cwd).stdout.strip()

    def count_commits(self, old, new, cwd):
        return int(self.run("rev-list", "--count", f"{old}..{new}", cwd=cwd).stdout.strip() or 0)

    def worktree_for(self, task_id):
        """Create (or reuse after a restart) the worktree for a task on branch task-<id>.
        Returns (path, note) where note describes any merge conflicts left for the engineer."""
        path = self.worktrees / f"task-{task_id}"
        branch = f"task-{task_id}"
        with self.lock:
            self.ensure_repo()
            main = self.main_branch()
            self.run("worktree", "prune", check=False)
            if not path.exists():
                self.worktrees.mkdir(parents=True, exist_ok=True)
                exists = self.run("rev-parse", "--verify", branch, check=False).returncode == 0
                if exists:
                    self.run("worktree", "add", str(path), branch)
                else:
                    self.run("worktree", "add", "-b", branch, str(path), main)
        note = ""
        # Bring an existing branch up to date with main (e.g. after a failed merge).
        r = self.run(*GIT_IDENTITY, "merge", "--no-edit", main, cwd=path, check=False)
        if r.returncode != 0:
            note = ("NOTE: merging the latest main into your branch produced conflicts. "
                    "Resolve every conflict marker first, then commit.\n")
        return path, note

    def merge_task(self, task_id, title):
        """Merge task-<id> into main. Returns (ok, error)."""
        branch = f"task-{task_id}"
        with self.lock:
            self.commit_all("Workspace: commit pending CEO/doc changes")
            r = self.run(*GIT_IDENTITY, "merge", "--no-ff", branch, "-m", f"Merge task #{task_id}: {title}", check=False)
            if r.returncode != 0:
                self.run("merge", "--abort", check=False)
                return False, (r.stderr or r.stdout).strip()[-300:]
            self.run("worktree", "remove", "--force", str(self.worktrees / branch), check=False)
            self.run("branch", "-D", branch, check=False)
        return True, ""


# ---------------------------------------------------------------- orchestrator

def read_doc(path):
    try:
        text = Path(path).read_text()
    except OSError:
        return "(none yet)"
    return text[:MAX_DOC_CHARS] + ("\n…(truncated)" if len(text) > MAX_DOC_CHARS else "")


def task_complexity(task):
    m = re.search(r"^complexity:\s*(trivial|standard)\s*$", task.get("description") or "", re.M | re.I)
    return m.group(1).lower() if m else "standard"


CEO_CHAT_PROMPT = """You are {ceo_name}, the CEO of a small AI software studio (the "Agent Office").
You talk with the user (your client) and decide what the team builds. Your team: 4 engineers and 2 QA.
The project workspace is your current directory. You may read files but do not edit them in this step.

## Current spec.md
{spec}

## Current BACKLOG.md
{backlog}

## Current tasks in the office
{tasks}

## Recent conversation (oldest first)
{conversation}

## Your job now
Reply to the user's latest message conversationally and concisely.
- If their request is vague, ask focused clarifying questions to converge on a concrete idea. Do NOT plan yet.
- Only when the idea is concrete enough to build (or the user asks to change the plan), choose action "plan";
  a separate architecting step will then write spec.md / BACKLOG.md and create tasks.
- If you hit a genuine decision you cannot make alone, choose action "escalate" and state the decision clearly.

End your answer with exactly one fenced JSON block:
```json
{{"reply": "<message to the user>", "action": "chat" | "plan" | "escalate", "needs_user": true | false}}
```
needs_user is true when your reply asks the user a question or needs a decision from them.
"""

CEO_PLAN_PROMPT = """You are {ceo_name}, the CEO/architect of a small AI software studio. The project workspace is your
current directory (a git repo). The user and you have converged on what to build.

## Recent conversation (oldest first)
{conversation}

## Current spec.md
{spec}

## Current BACKLOG.md
{backlog}

## Existing tasks in the office
{tasks}

## Your job now
1. Write/update `spec.md`: the product, scope, architecture, tech stack, and how to run the tests.
2. Write/update `BACKLOG.md`: an ordered list of NEW tasks for engineers.
3. Break the work into small, independently implementable tasks (each one a single engineer can finish
   in ~15 tool turns, including tests). Do not duplicate existing tasks. Prefer 3-8 tasks.
Do not implement the tasks yourself.

End your answer with exactly one fenced JSON block:
```json
{{"reply": "<short summary for the user of the plan>",
  "tasks": [{{"title": "...", "description": "...", "complexity": "trivial" | "standard"}}],
  "needs_user": false}}
```
Use complexity "trivial" only for tiny mechanical edits (renames, config tweaks, copy changes).
"""

ENGINEER_PROMPT = """You are {name}, a software engineer in the Agent Office. Your current directory is a git
worktree on branch task-{task_id} of the project. Read spec.md (and BACKLOG.md) for context.
{note}
## Your task #{task_id}: {title}
{description}

Implement the task completely, add or update tests where sensible, and make sure existing tests pass.
Commit your work with git (clear commit message). Stay within the scope of this task.

End your answer with exactly one fenced JSON block:
```json
{{"success": true | false, "summary": "<one or two sentences>"}}
```
"""

QA_PROMPT = """You are {name}, a QA engineer in the Agent Office. Your current directory is the git worktree
for task #{task_id} ("{title}"). Read spec.md to learn how tests are run.

Task description:
{description}

Run the project's test suite (and any quick checks relevant to this task). Do NOT modify any files.
Summarize the results.

End your answer with exactly one fenced JSON block:
```json
{{"passed": true | false, "tests_passed": <int>, "tests_failed": <int>, "summary": "<short summary>"}}
```
"""


class Orchestrator:
    def __init__(self, cfg):
        self.cfg = cfg
        self.office = Office(cfg["base_url"])
        self.claude = Claude(cfg)
        self.engineers = list(cfg["engineer_ids"])
        self.qas = list(cfg["qa_ids"])
        # Every project runs its own CEO/engineer/QA crew, so the pool is shared across rooms.
        per_project = 1 + len(self.engineers) + len(self.qas)
        self.pool = cf.ThreadPoolExecutor(max_workers=int(cfg.get("max_concurrent_runs", 2 * per_project)))
        # Runs currently in flight, keyed "<project>|ceo", "<project>|eng:<task>", "<project>|qa:<task>"
        # -> (project, agent_id, future). Agent and task ids repeat across projects, hence the prefix.
        self.inflight = {}
        self.attempts = {}  # (project, task_id) -> failed attempts this process lifetime (soft guard only)
        self.gits = {}      # project -> Git for <workspace>/<project>/
        self.gits_lock = threading.Lock()
        self.stopping = False

    # ---- projects

    def projects(self):
        """Ids of every project room; ids that aren't safe directory names are skipped."""
        ids = []
        for p in self.office.projects():
            pid = str(p.get("id") or "")
            if PROJECT_ID_RE.fullmatch(pid):
                ids.append(pid)
            else:
                log(f"WARN skipping project with unsafe id {pid!r}")
        return ids

    def git(self, project):
        with self.gits_lock:
            if project not in self.gits:
                self.gits[project] = Git(Path(self.cfg["workspace"]) / project)
            return self.gits[project]

    @staticmethod
    def key(project, name):
        return f"{project}|{name}"

    # ---- lifecycle

    def recover(self):
        """Nothing is running at startup, so anything the DB says is mid-flight was
        interrupted by a previous kill: put it back in a runnable state."""
        for project in self.projects():
            state = self.office.state(project)
            for t in state.get("tasks", []):
                if t["status"] == "in_progress":
                    self.office.task_status(t["id"], "todo", project=project)
                    log(f"recover: [{project}] task #{t['id']} in_progress -> todo")
            for a in state.get("agents", []):
                if a["status"] not in ("idle", "done"):
                    self.office.agent(a["id"], "idle", current_task="", project=project)
                    log(f"recover: [{project}] agent {a['id']} {a['status']} -> idle")

    def shutdown(self):
        self.stopping = True
        self.claude.terminate_all()
        self.pool.shutdown(wait=True, cancel_futures=True)

    # ---- polling

    def cycle(self):
        """One poll cycle: reap finished runs, then schedule new work in every project."""
        self.reap()
        projects = self.projects()
        log(f"cycle: {len(projects)} project(s): {', '.join(projects) or '-'}")
        for project in projects:
            try:
                state = self.office.state(project)
            except (urllib.error.URLError, OSError) as e:
                log(f"WARN [{project}] state poll failed: {e}")
                continue
            self.schedule_ceo(state, project)
            self.schedule_engineers(state, project)
            self.schedule_qa(state, project)

    def reap(self):
        for key, (project, agent_id, fut) in list(self.inflight.items()):
            if fut.done():
                del self.inflight[key]
                exc = fut.exception()
                if exc:
                    log(f"ERROR {key}: {exc!r}")
                    self.office.event(agent_id, f"Internal error in {key}: {exc}", "error", project=project)
                    self.office.agent(agent_id, "idle", current_task="", project=project)

    def busy_agents(self, project):
        return {agent_id for p, agent_id, _ in self.inflight.values() if p == project}

    def submit(self, project, name, agent_id, fn, *args):
        self.inflight[self.key(project, name)] = (project, agent_id, self.pool.submit(fn, *args))

    def wait_all(self):
        while self.inflight:
            cf.wait([f for _, _, f in self.inflight.values()])
            self.reap()

    # ---- CEO

    def schedule_ceo(self, state, project):
        if self.key(project, "ceo") in self.inflight:
            return
        convo = state.get("conversation", [])
        # A user message with no CEO reply after it is the only trigger (derived from the DB).
        if convo and convo[-1]["speaker"] == "user":
            log(f"[{project}] pending user message -> CEO")
            self.submit(project, "ceo", "ceo", self.run_ceo, state, project)

    @staticmethod
    def ceo_name(state):
        for a in state.get("agents", []):
            if a.get("role") == "ceo" and a.get("name"):
                return a["name"]
        return DEFAULT_CEO_NAME

    def _context(self, state, project):
        convo = state.get("conversation", [])[-RECENT_MESSAGES:]
        conversation = "\n".join(f"{m['speaker'].upper()}: {m['message']}" for m in convo) or "(empty)"
        tasks = "\n".join(f"#{t['id']} [{t['status']}] {t['title']}" for t in state.get("tasks", [])) or "(none)"
        ws = self.git(project).ws
        return dict(conversation=conversation, tasks=tasks, ceo_name=self.ceo_name(state),
                    spec=read_doc(ws / "spec.md"), backlog=read_doc(ws / "BACKLOG.md"))

    def run_ceo(self, state, project):
        ctx = self._context(state, project)
        last_user = state["conversation"][-1]
        git = self.git(project)
        git.ensure_repo()
        ws = str(git.ws)
        tier = self.cfg["tiers"]["ceo_chat"]

        self.office.agent("ceo", "thinking", current_task="Talking with the user",
                          model=tier["model"], effort=tier["effort"], project=project)
        self.office.event("ceo", "CEO thinking…", "think", project=project)
        ok, text, info = self.claude.run("ceo_chat", CEO_CHAT_PROMPT.format(**ctx), ws, tools="Read")
        if not ok and not text:
            self.office.event("ceo", f"CEO run failed: {info.get('error')}", "error", project=project)
            # Reply anyway so the message is not retried forever on every poll.
            self.office.message("ceo", "Sorry — I hit an internal error answering that. Could you say it again?",
                                project=project)
            self.office.agent("ceo", "idle", current_task="", project=project)
            return

        decision = extract_json(text) or {}
        reply = (decision.get("reply") or strip_json(text) or "…").strip()
        action = decision.get("action", "chat")
        needs_user = bool(decision.get("needs_user")) or action == "escalate"
        self.office.message("ceo", reply, project=project)
        self.office.event("ceo", f"Replied to user ({action}, ${info.get('cost_usd') or 0:.3f})", "talk",
                          project=project)
        if needs_user:
            self.notify_discord("escalation" if action == "escalate" else "question", reply, last_user, project)
            self.office.agent("ceo", "waiting", current_task="Waiting for the user", project=project)

        if action == "plan":
            self.run_ceo_plan(ctx, last_user, project)
        elif not needs_user:
            self.office.agent("ceo", "idle", current_task="", project=project)

    def run_ceo_plan(self, ctx, last_user, project):
        tier = self.cfg["tiers"]["ceo_plan"]
        git = self.git(project)
        ws = str(git.ws)
        self.office.agent("ceo", "thinking", current_task="Architecting the plan",
                          model=tier["model"], effort=tier["effort"], project=project)
        self.office.event("ceo", "CEO architecting: writing spec.md and BACKLOG.md", "think", project=project)
        ok, text, info = self.claude.run("ceo_plan", CEO_PLAN_PROMPT.format(**ctx), ws)
        plan = extract_json(text) or {}
        tasks = [t for t in plan.get("tasks") or [] if isinstance(t, dict) and t.get("title")]
        if not ok and not tasks:
            self.office.event("ceo", f"Planning failed: {info.get('error')}", "error", project=project)
            self.office.message("ceo", "I couldn't finish the plan just now — I'll need another go. "
                                       "Tell me to retry or adjust the request.", project=project)
            self.office.agent("ceo", "idle", current_task="", project=project)
            return

        with git.lock:
            git.commit_all("CEO: update spec and backlog")
        for t in tasks:
            complexity = "trivial" if str(t.get("complexity", "")).lower() == "trivial" else "standard"
            desc = f"{(t.get('description') or '').strip()}\n\ncomplexity: {complexity}"
            tid = self.office.create_task(t["title"].strip()[:200], desc, project=project)
            self.office.event("ceo", f"Created task #{tid}: {t['title']}", "info", project=project)

        reply = (plan.get("reply") or strip_json(text) or "Plan ready.").strip()
        self.office.message("ceo", reply, project=project)
        self.office.event("ceo", f"Plan ready: {len(tasks)} task(s) delegated (${info.get('cost_usd') or 0:.3f})",
                          "success", project=project)
        if plan.get("needs_user"):
            self.notify_discord("question", reply, last_user, project)
            self.office.agent("ceo", "waiting", current_task="Waiting for the user", project=project)
        else:
            self.office.agent("ceo", "done" if tasks else "idle", current_task="", project=project)

    # ---- Discord bridge

    def notify_discord(self, kind, message, last_user, project):
        """Hook for the Hermes layer: append one JSON line per message for the user."""
        record = {
            "ts": int(time.time()),
            "iso": datetime.now(timezone.utc).isoformat(),
            "source": "agent-office",
            "project": project,
            "agent_id": "ceo",
            "kind": kind,  # question | escalation
            "message": message,
            "in_reply_to": {"id": last_user.get("id"), "message": last_user.get("message")},
            "dashboard": self.cfg["base_url"],
        }
        path = Path(self.cfg["pending_discord_file"])
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a") as f:
            f.write(json.dumps(record) + "\n")
        log(f"discord: queued [{project}] {kind} -> {path}")

    # ---- engineers

    def schedule_engineers(self, state, project):
        busy = self.busy_agents(project)
        idle = [e for e in self.engineers if e not in busy]
        for t in state.get("tasks", []):
            if not idle:
                break
            if t["status"] != "todo" or self.key(project, f"eng:{t['id']}") in self.inflight:
                continue
            eng = idle.pop(0)
            self.office.task_status(t["id"], "in_progress", assignee=eng, project=project)
            self.submit(project, f"eng:{t['id']}", eng, self.run_engineer,
                        project, eng, t, self.agent_name(state, eng))

    @staticmethod
    def agent_name(state, agent_id):
        for a in state.get("agents", []):
            if a["id"] == agent_id:
                return a["name"]
        return agent_id

    def run_engineer(self, project, eng, task, name):
        tid, title = task["id"], task["title"]
        tier_name = "eng_trivial" if task_complexity(task) == "trivial" else "eng_standard"
        tier = self.cfg["tiers"][tier_name]
        git = self.git(project)
        self.office.agent(eng, "working", current_task=f"#{tid} {title}",
                          model=tier["model"], effort=tier["effort"], project=project)
        self.office.event(eng, f"Started task #{tid}: {title}", "info", project=project)

        path, note = git.worktree_for(tid)
        before = git.run("rev-parse", git.main_branch(), cwd=git.ws).stdout.strip()
        prompt = ENGINEER_PROMPT.format(name=name, task_id=tid, title=title,
                                        description=task.get("description") or "", note=note)
        ok, text, info = self.claude.run(tier_name, prompt, str(path))
        result = extract_json(text) or {}
        # Safety net: commit anything the engineer left uncommitted.
        git.commit_all(f"Task #{tid}: {title}", cwd=path)
        commits = git.count_commits(before, git.head(path), cwd=path)
        if commits:
            self.office.incr("commits", commits, project=project)

        success = ok and result.get("success", True) is not False and commits > 0
        summary = result.get("summary") or strip_json(text)[:300] or info.get("error") or ""
        if success:
            self.office.task_status(tid, "review", assignee=eng, project=project)
            self.office.event(eng, f"Task #{tid} implemented ({commits} commit(s)), sent to QA: {summary}",
                              "success", project=project)
        else:
            self.fail_task(project, tid, eng, f"Task #{tid} failed: {summary or info.get('error')}")
        self.office.agent(eng, "idle", current_task="", project=project)

    def fail_task(self, project, tid, agent_id, message):
        k = (project, tid)
        self.attempts[k] = self.attempts.get(k, 0) + 1
        if self.attempts[k] >= MAX_TASK_ATTEMPTS:
            self.office.task_status(tid, "blocked", project=project)
            self.office.event(agent_id, f"{message} — blocked after {self.attempts[k]} attempts", "error",
                              project=project)
        else:
            self.office.task_status(tid, "todo", project=project)
            self.office.event(agent_id, message, "error", project=project)

    # ---- QA

    def schedule_qa(self, state, project):
        busy = self.busy_agents(project)
        idle = [q for q in self.qas if q not in busy]
        for t in state.get("tasks", []):
            if not idle:
                break
            if t["status"] != "review" or self.key(project, f"qa:{t['id']}") in self.inflight:
                continue
            qa = idle.pop(0)
            self.submit(project, f"qa:{t['id']}", qa, self.run_qa, project, qa, t, self.agent_name(state, qa))

    def run_qa(self, project, qa, task, name):
        tid, title = task["id"], task["title"]
        tier = self.cfg["tiers"]["qa_tests"]
        git = self.git(project)
        self.office.agent(qa, "testing", current_task=f"#{tid} {title}",
                          model=tier["model"], effort=tier["effort"], project=project)
        self.office.event(qa, f"Testing task #{tid}: {title}", "info", project=project)

        path, _ = git.worktree_for(tid)
        prompt = QA_PROMPT.format(name=name, task_id=tid, title=title, description=task.get("description") or "")
        ok, text, info = self.claude.run("qa_tests", prompt, str(path), tools="Read,Bash")
        verdict = extract_json(text)
        if not ok and verdict is None:
            # QA itself broke (budget/timeout): leave the task in review for another try.
            self.office.event(qa, f"QA run for task #{tid} failed: {info.get('error')}", "error", project=project)
            self.office.agent(qa, "idle", current_task="", project=project)
            return
        verdict = verdict or {}
        passed = bool(verdict.get("passed"))
        n_pass = max(int(verdict.get("tests_passed") or 0), 0)
        n_fail = max(int(verdict.get("tests_failed") or 0), 0)
        if passed:
            self.office.incr("tests_passed", n_pass or 1, project=project)
        else:
            self.office.incr("tests_failed", n_fail or 1, project=project)
        if n_pass and not passed:
            self.office.incr("tests_passed", n_pass, project=project)
        summary = verdict.get("summary") or strip_json(text)[:300]

        if passed:
            merged, err = git.merge_task(tid, title)
            if merged:
                self.office.task_status(tid, "done", project=project)
                self.office.incr("floors", project=project)
                self.office.incr("tasks_done", project=project)
                self.office.event(qa, f"Task #{tid} passed QA and merged: {summary}", "success", project=project)
            else:
                self.fail_task(project, tid, qa, f"Task #{tid} passed QA but merge failed: {err}")
        else:
            self.fail_task(project, tid, qa, f"Task #{tid} failed QA: {summary}")
        self.office.agent(qa, "idle", current_task="", project=project)


# ---------------------------------------------------------------- main

def acquire_lock(workspace):
    path = Path(workspace).parent / ".orchestrator.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    fh = open(path, "w")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit(f"another orchestrator is already running (lock: {path})")
    fh.write(str(os.getpid()))
    fh.flush()
    return fh


def main():
    ap = argparse.ArgumentParser(description="Agent Office orchestrator")
    ap.add_argument("--config", default=str(HERE / "config.json"))
    ap.add_argument("--once", action="store_true", help="run a single poll cycle (and its runs), then exit")
    args = ap.parse_args()

    cfg = load_config(args.config)
    _lock = acquire_lock(cfg["workspace"])
    orch = Orchestrator(cfg)

    def on_signal(signum, _frame):
        log(f"received signal {signum}, shutting down")
        orch.stopping = True
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    log(f"orchestrator starting (base_url={cfg['base_url']}, workspaces={cfg['workspace']}/<project>, "
        f"once={args.once})")
    for name, tier in cfg["tiers"].items():
        log(f"  tier {name:<13} model={tier['model']:<6} effort={tier['effort']}")

    try:
        orch.recover()
    except (urllib.error.URLError, OSError) as e:
        log(f"ERROR office server unreachable at {cfg['base_url']}: {e}")
        return 1

    try:
        if args.once:
            orch.cycle()
            orch.wait_all()
            log("single cycle complete")
            return 0
        while not orch.stopping:
            try:
                orch.cycle()
            except (urllib.error.URLError, OSError) as e:
                log(f"WARN poll failed: {e}")
            for _ in range(int(cfg["poll_interval_sec"] * 10)):
                if orch.stopping:
                    break
                time.sleep(0.1)
        return 0
    finally:
        orch.shutdown()
        try:
            orch.recover()  # put interrupted tasks/agents back so a restart picks them up
        except (urllib.error.URLError, OSError):
            pass
        log("orchestrator stopped")


if __name__ == "__main__":
    sys.exit(main())

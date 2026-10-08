/* Agent Office — animated canvas renderer. Pure Canvas 2D, no deps.
   Every visual state is driven by the live snapshot from the server. */

(function () {
  const canvas = document.getElementById("office-canvas");
  const ctx = canvas.getContext("2d");

  let W = 0, H = 0;
  let state = null;                 // latest snapshot from server
  let agents = [];                  // visual agent objects (position interpolated)
  let bubbles = [];                 // floating speech bubbles
  let particles = [];               // success/fail bursts
  let lastEventId = 0;
  let clock = 0;

  const STATUS_COLOR = {
    idle: "#8792a3",
    thinking: "#fbbf24",
    working: "#4f9cf9",
    testing: "#a78bfa",
    blocked: "#f87171",
    waiting: "#fbbf24",
    done: "#34d399",
  };
  const STATUS_EMOJI = {
    idle: "🙂",
    thinking: "🤔",
    working: "👨‍💻",
    testing: "🧪",
    blocked: "⛔",
    waiting: "⏳",
    done: "✅",
  };

  function resize() {
    const r = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    W = r.width; H = r.height;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---- visual agent factory ----
  function makeVisualAgent(a) {
    return {
      id: a.id,
      role: a.role,
      name: a.name,
      status: a.status || "idle",
      currentTask: a.current_task || "",
      // normalized desk position
      home: { x: a.desk_x * W, y: a.desk_y * H },
      pos: { x: a.desk_x * W, y: a.desk_y * H },
      wander: { x: a.desk_x * W, y: a.desk_y * H },
      phase: Math.random() * Math.PI * 2,   // idle bob phase
      walkT: 0,
      speech: "",
      speechUntil: 0,
    };
  }

  function syncAgents() {
    if (!state) return;
    const byId = {};
    agents.forEach(v => { byId[v.id] = v; });
    agents = (state.agents || []).map(a => {
      const v = byId[a.id] || makeVisualAgent(a);
      // refresh persistent fields
      v.role = a.role; v.name = a.name;
      v.home = { x: a.desk_x * W, y: a.desk_y * H };
      // status change => set target + maybe bubble
      if (a.status !== v.status) {
        v.status = a.status;
        if (a.status === "working" || a.status === "testing") {
          v.wander = v.home;
          v.walkT = 1;
        }
      }
      v.currentTask = a.current_task || "";
      if (a.status !== "idle" && a.status !== "waiting" && a.status !== "done") {
        v.wander = v.home;
        v.walkT = 1;
      }
      return v;
    });
  }

  function findAgent(id) {
    return agents.find(v => v.id === id);
  }

  function say(agentId, text, type) {
    const v = findAgent(agentId);
    if (!v) return;
    v.speech = text;
    v.speechUntil = clock + 4.5;
    const col = type === "error" ? "#f87171" : type === "success" ? "#34d399"
              : type === "think" ? "#fbbf24" : "#4f9cf9";
    bubbles.push({ x: v.pos.x, y: v.pos.y, text, col, until: clock + 4.5 });
  }

  // ---- consume new events since last sync ----
  function processEvents() {
    if (!state) return;
    const evs = state.events || [];
    evs.forEach(e => {
      if (e.id <= lastEventId) return;
      lastEventId = Math.max(lastEventId, e.id);
      const v = findAgent(e.agent_id);
      if (!v) return;
      say(e.agent_id, e.message, e.type);
      if (e.type === "success") burst(v.pos.x, v.pos.y, "#34d399", 14);
      if (e.type === "error") burst(v.pos.x, v.pos.y, "#f87171", 14);
    });
  }

  function burst(x, y, color, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1 + Math.random() * 3;
      particles.push({
        x, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 1, color,
      });
    }
  }

  // ---- drawing helpers ----
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawDesk(x, y, status) {
    // desk
    ctx.fillStyle = "#232b36";
    roundRect(x - 30, y - 12, 60, 24, 4);
    ctx.fill();
    ctx.fillStyle = "#2c3542";
    roundRect(x - 30, y - 12, 60, 6, 3);
    ctx.fill();
    // monitor
    ctx.fillStyle = "#0f141b";
    roundRect(x - 16, y - 34, 32, 24, 3);
    ctx.fill();
    ctx.strokeStyle = "#3a4654";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // screen glow when active
    if (status === "working" || status === "testing" || status === "thinking") {
      ctx.fillStyle = "rgba(79,156,249,0.35)";
      roundRect(x - 13, y - 31, 26, 18, 2);
      ctx.fill();
    }
  }

  function drawWorker(v, t) {
    const { x, y } = v.pos;
    const working = v.status === "working" || v.status === "testing";
    const thinking = v.status === "thinking";
    const blocked = v.status === "blocked";

    // shadow
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath();
    ctx.ellipse(x, y + 22, 14, 4, 0, 0, Math.PI * 2);
    ctx.fill();

    // bob while idle, hammer while working
    let bob = 0;
    if (v.status === "idle" || v.status === "waiting") bob = Math.sin(clock * 2 + v.phase) * 2;
    if (working) bob = Math.abs(Math.sin(clock * 8 + v.phase)) * -3;
    if (thinking) bob = Math.sin(clock * 3 + v.phase) * 1.5;

    const wy = y - 8 + bob;

    // body
    ctx.fillStyle = STATUS_COLOR[v.status] || "#8792a3";
    ctx.beginPath();
    ctx.ellipse(x, wy, 13, 16, 0, 0, Math.PI * 2);
    ctx.fill();

    // head
    ctx.fillStyle = "#f3d9b1";
    ctx.beginPath();
    ctx.arc(x, wy - 24, 10, 0, Math.PI * 2);
    ctx.fill();

    // face
    ctx.fillStyle = "#1b2430";
    ctx.beginPath();
    ctx.arc(x - 3.5, wy - 25, 1.4, 0, Math.PI * 2);
    ctx.arc(x + 3.5, wy - 25, 1.4, 0, Math.PI * 2);
    ctx.fill();

    // role hat
    ctx.fillStyle = v.role === "ceo" ? "#fbbf24" : v.role === "qa" ? "#a78bfa" : "#4f9cf9";
    ctx.beginPath();
    ctx.arc(x, wy - 34, 8, Math.PI, 0);
    ctx.fill();
    ctx.fillRect(x - 8, wy - 36, 16, 3);

    // blocked marker
    if (blocked) {
      ctx.font = "16px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("⚠️", x, wy - 42);
    }
    if (thinking) {
      ctx.font = "14px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("💭", x + 16, wy - 40);
    }

    // name + status text
    ctx.font = "600 11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "#dbe2ea";
    ctx.fillText(v.name, x, y + 40);
    ctx.font = "10px sans-serif";
    ctx.fillStyle = STATUS_COLOR[v.status] || "#8792a3";
    ctx.fillText(STATUS_EMOJI[v.status] + " " + v.status, x, y + 52);
  }

  function drawBuilding() {
    if (!state || !state.metrics) return;
    const floors = state.metrics.floors || 0;
    if (floors <= 0) {
      // empty plot
      ctx.strokeStyle = "#2a3441";
      ctx.lineWidth = 2;
      roundRect(W - 150, H - 120, 90, 90, 6);
      ctx.stroke();
      ctx.fillStyle = "#2a3441";
      ctx.font = "11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("🏗️ build site", W - 105, H - 70);
      return;
    }
    const bw = 90, bh = 18, gap = 2;
    const baseY = H - 30;
    const startY = baseY - bh;
    for (let i = 0; i < Math.min(floors, 20); i++) {
      const fy = startY - i * (bh + gap);
      ctx.fillStyle = i % 2 ? "#3b4a5c" : "#46586c";
      roundRect(W - 150, fy, bw, bh, 3);
      ctx.fill();
      // windows
      ctx.fillStyle = "#ffd166";
      for (let w = 0; w < 4; w++) {
        ctx.fillRect(W - 142 + w * 20, fy + 5, 8, 8);
      }
    }
    ctx.fillStyle = "#dbe2ea";
    ctx.font = "600 12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("🏢 " + floors + " floor" + (floors > 1 ? "s" : ""), W - 105, startY - 20 * (bh + gap) - 8);
  }

  function drawBubbles() {
    bubbles = bubbles.filter(b => b.until > clock);
    bubbles.forEach(b => {
      const age = b.until - clock;
      const alpha = Math.min(1, age);
      const w = Math.min(220, ctx.measureText(b.text).width + 24);
      const h = 30;
      const bx = Math.max(10, Math.min(W - w - 10, b.x - w / 2));
      const by = Math.max(10, b.y - 70);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "#0e1116";
      roundRect(bx, by, w, h, 8);
      ctx.fill();
      ctx.strokeStyle = b.col;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = "#dbe2ea";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(b.text, bx + 12, by + 20);
      ctx.globalAlpha = 1;
    });
  }

  function drawParticles() {
    particles = particles.filter(p => p.life > 0);
    particles.forEach(p => {
      p.x += p.vx; p.y += p.vy;
      p.vy += 0.06;
      p.life -= 0.02;
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  }

  function drawFloor() {
    // carpet
    ctx.fillStyle = "#141922";
    ctx.fillRect(0, H - 60, W, 60);
    ctx.fillStyle = "#1c232d";
    for (let x = 0; x < W; x += 80) {
      ctx.fillRect(x, H - 60, 1, 60);
    }
  }

  function updatePositions(dt) {
    agents.forEach(v => {
      const target = (v.status === "idle" || v.status === "waiting" || v.status === "done")
        ? v.wander : v.home;
      const dx = target.x - v.pos.x;
      const dy = target.y - v.pos.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 1) {
        const sp = 80 * dt;
        v.pos.x += (dx / dist) * sp;
        v.pos.y += (dy / dist) * sp;
      } else {
        v.pos.x = target.x; v.pos.y = target.y;
        // idle wandering
        if ((v.status === "idle" || v.status === "waiting") && Math.random() < 0.005) {
          v.wander = {
            x: v.home.x + (Math.random() - 0.5) * 120,
            y: v.home.y + (Math.random() - 0.5) * 60,
          };
        }
      }
      // keep in bounds
      v.pos.x = Math.max(30, Math.min(W - 30, v.pos.x));
      v.pos.y = Math.max(40, Math.min(H - 80, v.pos.y));
    });
  }

  function render(dt) {
    ctx.clearRect(0, 0, W, H);
    // floor + building first (background)
    drawFloor();
    drawBuilding();
    // desks under workers
    agents.forEach(v => drawDesk(v.home.x, v.home.y, v.status));
    // workers
    agents.forEach(v => drawWorker(v, clock));
    // bubbles + particles on top
    drawBubbles();
    drawParticles();
  }

  function loop(t) {
    clock = t / 1000;
    const dt = 0.016;
    updatePositions(dt);
    render(dt);
    requestAnimationFrame(loop);
  }

  // ---- state ingestion from websocket ----
  function ingest(snap) {
    state = snap;
    syncAgents();
    processEvents();
    updateSidebar(snap);
  }

  function updateSidebar(snap) {
    updateMessages(snap.conversation || []);
    updateLog(snap.events || []);
    updateTasks(snap.tasks || []);
    updateMetrics(snap.metrics || {});
  }

  // ---- sidebar rendering ----
  const messagesEl = document.getElementById("messages");
  function updateMessages(conv) {
    messagesEl.innerHTML = "";
    conv.forEach(m => {
      const d = document.createElement("div");
      d.className = "msg " + m.speaker;
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = m.speaker === "user" ? "You" : "CEO";
      const txt = document.createElement("span");
      txt.textContent = m.message;
      d.appendChild(who); d.appendChild(txt);
      messagesEl.appendChild(d);
    });
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  const logEl = document.getElementById("log");
  function updateLog(events) {
    logEl.innerHTML = "";
    events.slice().reverse().forEach(e => {
      const d = document.createElement("div");
      d.className = "ev " + e.type;
      const b = document.createElement("b");
      const ag = findAgent(e.agent_id);
      b.textContent = (ag ? ag.name : e.agent_id) + ": ";
      d.appendChild(b);
      d.appendChild(document.createTextNode(e.message));
      logEl.appendChild(d);
    });
    logEl.scrollTop = logEl.scrollHeight;
  }

  const tasksEl = document.getElementById("tasklist");
  function updateTasks(tasks) {
    tasksEl.innerHTML = "";
    if (!tasks.length) {
      tasksEl.innerHTML = '<div class="ev">No tasks yet — talk to the CEO.</div>';
      return;
    }
    tasks.forEach(t => {
      const d = document.createElement("div");
      d.className = "task";
      d.innerHTML = '<div class="t-title">' + escapeHtml(t.title) + '</div>' +
        '<div class="t-meta"><span class="badge ' + t.status + '">' + t.status + '</span>' +
        (t.assignee ? '<span>👤 ' + escapeHtml(t.assignee) + '</span>' : '<span>unassigned</span>') +
        '</div>';
      tasksEl.appendChild(d);
    });
  }

  const metricsEl = document.getElementById("metrics");
  function updateMetrics(m) {
    metricsEl.innerHTML = "";
    const items = [
      ["🏢 floors", m.floors || 0],
      ["📦 commits", m.commits || 0],
      ["✅ tests", m.tests_passed || 0],
      ["❌ fails", m.tests_failed || 0],
      ["✔ tasks", m.tasks_done || 0],
    ];
    items.forEach(([label, val]) => {
      const d = document.createElement("div");
      d.className = "metric";
      d.innerHTML = "<span>" + label + "</span><b>" + val + "</b>";
      metricsEl.appendChild(d);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // ---- websocket ----
  function connect() {
    const statusEl = document.getElementById("status");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(proto + "://" + location.host + "/ws");
    ws.onopen = () => {
      statusEl.textContent = "● live";
      document.querySelector("header .dot").classList.add("live");
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "snapshot") ingest(msg.data);
    };
    ws.onclose = () => {
      statusEl.textContent = "reconnecting…";
      document.querySelector("header .dot").classList.remove("live");
      setTimeout(connect, 1500);
    };
  }

  // ---- chat ----
  const chatInput = document.getElementById("chatinput");
  const chatSend = document.getElementById("chatsend");
  function sendChat() {
    const text = chatInput.value.trim();
    if (!text) return;
    chatSend.disabled = true;
    fetch("/api/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speaker: "user", message: text }),
    }).then(() => {
      chatInput.value = "";
      chatSend.disabled = false;
    });
  }
  chatSend.addEventListener("click", sendChat);
  chatInput.addEventListener("keydown", e => { if (e.key === "Enter") sendChat(); });

  // ---- tabs ----
  document.querySelectorAll(".tabs button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tabs button").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(btn.dataset.panel).classList.add("active");
    });
  });

  // ---- boot ----
  window.addEventListener("resize", resize);
  resize();
  connect();
  requestAnimationFrame(loop);
})();

/* Agent Office — 3D low-poly office (Three.js, vendored, offline).
   Every visual state is driven by the live snapshot from the server:
   { agents, tasks, events, conversation, metrics }  via  ingest(snapshot). */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, k) => a + (b - a) * k;
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ------------------------------------------------------------------ */
/* Semantics                                                          */
/* ------------------------------------------------------------------ */
const STATUS_COLOR = {
  idle: '#8792a3', thinking: '#fbbf24', working: '#4f9cf9', testing: '#a78bfa',
  blocked: '#f87171', waiting: '#fbbf24', done: '#34d399',
};
const STATUS_ICON = {
  idle: '💤', thinking: '💭', working: '💻', testing: '🧪', blocked: '⚠️', waiting: '⏳', done: '✅',
};
const ROLE_COLOR = { ceo: '#fbbf24', engineer: '#4f9cf9', qa: '#a78bfa' };
const ROLE_LABEL = { ceo: 'CEO', engineer: 'Engineer', qa: 'QA' };
const EVENT_COLOR = { info: '#4f9cf9', success: '#34d399', error: '#f87171', think: '#fbbf24', talk: '#a78bfa' };
const SEATED = new Set(['working', 'testing', 'blocked']);

/* ------------------------------------------------------------------ */
/* Shared state                                                       */
/* ------------------------------------------------------------------ */
let state = null;
let lastEventId = 0;
let firstSnapshot = true;
let world = null;          // 3D world (null if WebGL unavailable)
let followId = null;       // agent currently followed by the camera

// localStorage can throw (private mode, disabled storage) — treat it as best-effort
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
};
let currentProject = store.get('office.project') || 'default';
let isDay = store.get('office.daynight') === 'day';

const nameOf = (id) => {
  const a = state && (state.agents || []).find((x) => x.id === id || x.name === id);
  return a ? a.name : id;
};

/* ------------------------------------------------------------------ */
/* 3D world                                                           */
/* ------------------------------------------------------------------ */
const FW = 44, FD = 30, WALL_H = 7.5;           // floor width / depth, wall height
const BX = 17, BZ = -8.5;                       // building plot
const HOME_TARGET = new THREE.Vector3(0, 0, 1);

function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < String(str).length; i++) { h ^= String(str).charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function initWorld() {
  const host = $('office');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  } catch (e) {
    $('nogl').hidden = false;
    return null;
  }
  // perf: fill rate dominates on hi-dpi screens; 1.5x is visually close to 2x at a ~44% lower pixel cost.
  // Re-clamped in resize() so moving between monitors / browser zoom keeps the budget.
  const DPR_CAP = 1.5;
  const pixelRatio = () => Math.min(window.devicePixelRatio || 1, DPR_CAP);
  renderer.setPixelRatio(pixelRatio());
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;    // perf: single-tap PCF instead of the soft multi-tap variant
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.domElement.id = 'office-canvas';
  host.insertBefore(renderer.domElement, host.firstChild);
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#080b11');
  scene.fog = new THREE.Fog('#080b11', 70, 140);

  const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 300);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.minDistance = 6;
  controls.maxDistance = 85;
  controls.screenSpacePanning = false;

  /* ---------------- lighting ---------------- */
  // values below are the night mood; applyMood() cross-fades them toward day
  const ambient = new THREE.AmbientLight(0x8a96b8, 0.35);
  const hemi = new THREE.HemisphereLight(0x9db8ff, 0x3a2a1c, 0.5);
  scene.add(ambient, hemi);
  const key = new THREE.DirectionalLight(0xcfe0ff, 1.15);          // cool "moonlight" through windows
  key.position.set(-16, 26, 14);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);                               // perf: 4x fewer shadow texels than 2048
  Object.assign(key.shadow.camera, { left: -32, right: 32, top: 24, bottom: -24, near: 1, far: 80 });
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.03;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffd2a0, 0.4);          // warm fill
  fill.position.set(20, 14, 22);
  scene.add(fill);

  /* ---------------- floor ---------------- */
  const floorTex = canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = '#2b2620'; g.fillRect(0, 0, w, h);
    const rows = 8, ph = h / rows;
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let r = 0; r < rows; r++) {
      let x = -rnd() * 200;
      while (x < w) {
        const pw = 150 + rnd() * 160;
        g.fillStyle = `hsl(${26 + rnd() * 6}, ${16 + rnd() * 8}%, ${19 + rnd() * 5}%)`;
        g.fillRect(x + 1, r * ph + 1, pw - 2, ph - 2);
        g.fillStyle = 'rgba(255,255,255,0.025)';
        for (let k = 0; k < 3; k++) g.fillRect(x + rnd() * pw, r * ph + 4 + rnd() * (ph - 8), 20 + rnd() * 50, 1);
        x += pw;
      }
    }
  });
  floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
  floorTex.repeat.set(FW / 8, FD / 8);
  floorTex.anisotropy = maxAniso;
  const sideMat = new THREE.MeshStandardMaterial({ color: '#171b24', roughness: 0.9 });
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(FW, 0.5, FD),
    [sideMat, sideMat, new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.62, metalness: 0.05 }), sideMat, sideMat, sideMat]
  );
  floor.position.y = -0.25;
  floor.receiveShadow = true;
  scene.add(floor);

  const groundMat = new THREE.MeshBasicMaterial({ color: '#06080c' });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), groundMat);
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.6;
  scene.add(ground);

  // rug under the desks
  const rug = new THREE.Mesh(
    new THREE.PlaneGeometry(32, 19),
    new THREE.MeshStandardMaterial({
      roughness: 1,
      map: canvasTex(256, 160, (g, w, h) => {
        g.fillStyle = '#1c2740'; g.fillRect(0, 0, w, h);
        g.strokeStyle = '#33466e'; g.lineWidth = 6; g.strokeRect(10, 10, w - 20, h - 20);
        g.strokeStyle = '#26365a'; g.lineWidth = 2; g.strokeRect(22, 22, w - 44, h - 44);
      }),
    })
  );
  rug.rotation.x = -Math.PI / 2; rug.position.set(-3, 0.02, 0);
  rug.receiveShadow = true;
  scene.add(rug);

  /* ---------------- walls + windows ---------------- */
  const wallMat = new THREE.MeshStandardMaterial({ color: '#1e2635', roughness: 0.95 });
  const trimMat = new THREE.MeshStandardMaterial({ color: '#2d3850', roughness: 0.7 });
  const back = new THREE.Mesh(new THREE.BoxGeometry(FW + 1, WALL_H, 0.5), wallMat);
  back.position.set(-0.25, WALL_H / 2, -FD / 2 - 0.25);
  const left = new THREE.Mesh(new THREE.BoxGeometry(0.5, WALL_H, FD), wallMat);
  left.position.set(-FW / 2 - 0.25, WALL_H / 2, 0);
  back.receiveShadow = left.receiveShadow = true;
  scene.add(back, left);
  const baseBack = new THREE.Mesh(new THREE.BoxGeometry(FW, 0.35, 0.15), trimMat);
  baseBack.position.set(0, 0.17, -FD / 2 + 0.07);
  const baseLeft = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.35, FD), trimMat);
  baseLeft.position.set(-FW / 2 + 0.07, 0.17, 0);
  const crown = new THREE.Mesh(new THREE.BoxGeometry(FW, 0.2, 0.2), trimMat);
  crown.position.set(0, WALL_H - 0.1, -FD / 2 + 0.1);
  const crownL = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, FD), trimMat);
  crownL.position.set(-FW / 2 + 0.1, WALL_H - 0.1, 0);
  scene.add(baseBack, baseLeft, crown, crownL);

  // window view; day and night share one RNG sequence so the skyline is identical in both
  const skyTex = (day) => canvasTex(256, 192, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    if (day) { gr.addColorStop(0, '#4f8fd8'); gr.addColorStop(0.7, '#9cc8ef'); gr.addColorStop(1, '#d6e8f6'); }
    else { gr.addColorStop(0, '#0d1838'); gr.addColorStop(0.7, '#2a4a80'); gr.addColorStop(1, '#4a6c9c'); }
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    let s = 3; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
    g.fillStyle = 'rgba(255,255,255,.7)';
    for (let i = 0; i < 24; i++) { const sx = r() * w, sy = r() * h * 0.5; if (!day) g.fillRect(sx, sy, 1.5, 1.5); }
    if (day) {
      const sun = g.createRadialGradient(w * 0.78, h * 0.2, 2, w * 0.78, h * 0.2, 34);
      sun.addColorStop(0, 'rgba(255,250,220,1)'); sun.addColorStop(0.35, 'rgba(255,240,190,.85)'); sun.addColorStop(1, 'rgba(255,240,190,0)');
      g.fillStyle = sun; g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(255,255,255,.85)';
      [[40, 34, 26], [62, 30, 18], [150, 52, 22], [170, 48, 15], [96, 70, 16]].forEach(([cx, cy, cr]) => {
        g.beginPath(); g.ellipse(cx, cy, cr * 1.6, cr * 0.6, 0, 0, Math.PI * 2); g.fill();
      });
    }
    for (let x = 0; x < w; x += 22) {
      const bh = 30 + r() * 60;
      g.fillStyle = day ? '#6d7d95' : '#0a0f1d'; g.fillRect(x, h - bh, 20, bh);
      g.fillStyle = day ? '#43526b' : '#ffd88a';
      for (let y = h - bh + 6; y < h - 4; y += 9) for (let xx = x + 3; xx < x + 17; xx += 7) if (r() > 0.55) g.fillRect(xx, y, 3, 4);
    }
  });
  const skyNight = skyTex(false), skyDay = skyTex(true);
  const paneMat = new THREE.MeshStandardMaterial({ color: '#000', emissive: '#fff', emissiveMap: skyNight, emissiveIntensity: 0.75 });
  const frameMat = new THREE.MeshStandardMaterial({ color: '#10141d', roughness: 0.5, metalness: 0.4 });
  function addWindow(parent, w, h, x, y, z, ry) {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.PlaneGeometry(w, h), paneMat));
    const t = 0.18;
    const bars = [[w + t, t, 0, h / 2], [w + t, t, 0, -h / 2], [t, h, w / 2, 0], [t, h, -w / 2, 0], [t * 0.6, h, 0, 0], [w, t * 0.6, 0, 0]];
    bars.forEach(([bw, bh, bx, by]) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, 0.16), frameMat);
      m.position.set(bx, by, 0.04); g.add(m);
    });
    const sill = new THREE.Mesh(new THREE.BoxGeometry(w + 0.8, 0.14, 0.5), trimMat);
    sill.position.set(0, -h / 2 - 0.15, 0.2); g.add(sill);
    g.position.set(x, y, z); g.rotation.y = ry;
    parent.add(g);
  }
  [-15, -3, 9].forEach((x) => addWindow(scene, 6, 3.8, x, 4.1, -FD / 2 + 0.03, 0));
  [-8, 1, 10].forEach((z) => addWindow(scene, 5, 3.8, -FW / 2 + 0.03, 4.1, z, Math.PI / 2));

  /* ---------------- plants, lamps, shelf ---------------- */
  const swayers = [];
  function addPlant(x, z, s = 1) {
    const g = new THREE.Group();
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.42, 0.9, 10), new THREE.MeshStandardMaterial({ color: '#b5683a', roughness: 0.8 }));
    pot.position.y = 0.45; pot.castShadow = true; g.add(pot);
    const soil = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.06, 10), new THREE.MeshStandardMaterial({ color: '#2a1d14' }));
    soil.position.y = 0.9; g.add(soil);
    const holder = new THREE.Group(); holder.position.y = 0.9; g.add(holder);
    const leafGeo = new THREE.ConeGeometry(0.2, 1.9, 5); leafGeo.translate(0, 0.95, 0);
    for (let i = 0; i < 9; i++) {
      const leaf = new THREE.Group();
      leaf.rotation.set(0.25 + (i % 3) * 0.2, (i / 9) * Math.PI * 2, 0, 'YXZ');
      const m = new THREE.Mesh(leafGeo, new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(0.33 + (i % 4) * 0.012, 0.5, 0.26 + (i % 3) * 0.04), roughness: 0.8 }));
      leaf.add(m); holder.add(leaf);                 // perf: leaves don't cast shadows (36 fewer shadow draws)
    }
    g.position.set(x, 0, z); g.scale.setScalar(s);
    scene.add(g); swayers.push({ holder, ph: x + z });
  }
  addPlant(-20.5, -13.5, 1.3);
  addPlant(-20.5, 12.5, 1.1);
  addPlant(5.5, -13.6, 0.9);
  addPlant(20, 12.5, 1.2);

  const shadeMat = new THREE.MeshStandardMaterial({ color: '#ffe0b0', emissive: '#ffb25c', emissiveIntensity: 1.1, side: THREE.DoubleSide, roughness: 0.6 });
  const lampMetal = new THREE.MeshStandardMaterial({ color: '#2a2f3a', metalness: 0.6, roughness: 0.4 });
  const bulbMat = new THREE.MeshBasicMaterial({ color: '#fff0cc' });
  const lampLights = [];
  // perf: every PointLight adds per-fragment work to every lit material, so only `lit` lamps get a real
  // light (slightly stronger/wider to compensate); the rest are emissive-only.
  function addLamp(x, z, lit) {
    const g = new THREE.Group();
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.65, 0.12, 14), lampMetal);
    base.position.y = 0.06;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 4.2, 8), lampMetal);
    pole.position.y = 2.2;
    const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.75, 0.9, 14, 1, true), shadeMat);
    shade.position.y = 4.4;
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), bulbMat);
    bulb.position.y = 4.35;
    g.add(base, pole, shade, bulb);
    if (lit) {
      const light = new THREE.PointLight(0xffc27a, 55, 26, 2);
      light.position.y = 4.2;
      g.add(light); lampLights.push(light);
    }
    g.traverse((m) => { if (m.isMesh && m !== bulb) m.castShadow = false; });
    g.position.set(x, 0, z); scene.add(g);
  }
  addLamp(-20, -3, false);
  addLamp(-8.5, -13.5, true);
  addLamp(21, 4, true);
  addLamp(-20, 8, false);

  // bookshelf on the left wall
  (function () {
    const g = new THREE.Group();
    const wood = new THREE.MeshStandardMaterial({ color: '#3a2c20', roughness: 0.8 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.2, 4, 5), wood); body.position.y = 2; g.add(body);
    for (let r = 0; r < 4; r++) {
      let z = -2.2;
      while (z < 2.2) {
        const bw = 0.25 + ((hash(r * 31 + z) % 5) * 0.06);
        const bk = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.7 - (hash(z * 7 + r) % 3) * 0.08, bw),
          new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL((hash(r * 13 + z * 5) % 100) / 100, 0.45, 0.4), roughness: 0.8 }));
        bk.position.set(0.25, 0.55 + r * 0.95, z + bw / 2); g.add(bk);
        z += bw + 0.04;
      }
    }
    body.castShadow = true;                          // perf: books sit inside the body's shadow anyway
    g.position.set(-FW / 2 + 0.8, 0, -10.5);
    scene.add(g);
  })();

  /* ---------------- shared builders ---------------- */
  const deskTopMat = new THREE.MeshStandardMaterial({ color: '#b98f5c', roughness: 0.55 });
  const deskLegMat = new THREE.MeshStandardMaterial({ color: '#2b3342', roughness: 0.6, metalness: 0.3 });
  const darkMat = new THREE.MeshStandardMaterial({ color: '#10141c', roughness: 0.5 });
  const chairMat = new THREE.MeshStandardMaterial({ color: '#2c3446', roughness: 0.7 });
  const glowTex = canvasTex(128, 128, (g, w, h) => {
    const gr = g.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.5, 'rgba(255,255,255,.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  });
  const emojiTex = new Map();
  function getEmojiTex(e) {
    if (!emojiTex.has(e)) {
      emojiTex.set(e, canvasTex(128, 128, (g, w, h) => {
        g.font = '92px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(e, w / 2, h / 2 + 6);
      }));
    }
    return emojiTex.get(e);
  }

  function buildDesk() {
    const g = new THREE.Group();
    const top = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.1, 1.5), deskTopMat); top.position.y = 1.0;
    g.add(top);
    [-1.45, 1.45].forEach((x) => {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.95, 1.3), deskLegMat); p.position.set(x, 0.5, 0); g.add(p);
    });
    const kb = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.05, 0.3), darkMat); kb.position.set(0, 1.07, 0.35); g.add(kb);
    const mouse = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.05, 0.22), darkMat); mouse.position.set(0.8, 1.07, 0.35); g.add(mouse);
    const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.09, 0.2, 10), new THREE.MeshStandardMaterial({ color: '#e8e8ee' }));
    mug.position.set(-1.1, 1.15, 0.2); g.add(mug);
    // monitor
    const stand = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.35, 0.15), darkMat); stand.position.set(0, 1.22, -0.4);
    const bezel = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.86, 0.07), darkMat); bezel.position.set(0, 1.78, -0.4);
    g.add(stand, bezel);
    const sc = document.createElement('canvas'); sc.width = 128; sc.height = 80;
    const stex = new THREE.CanvasTexture(sc); stex.colorSpace = THREE.SRGBColorSpace;
    const smat = new THREE.MeshStandardMaterial({ color: '#000', emissive: '#fff', emissiveMap: stex, emissiveIntensity: 1 });
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.26, 0.72), smat);
    screen.position.set(0, 1.78, -0.36); g.add(screen);
    // chair
    const chair = new THREE.Group();
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.12, 0.85), chairMat); seat.position.y = 0.58;
    const bk = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.9, 0.1), chairMat); bk.position.set(0, 1.1, 0.42);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.5, 8), deskLegMat); post.position.y = 0.3;
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.05, 5), deskLegMat); foot.position.y = 0.04;
    chair.add(seat, bk, post, foot); chair.position.set(0, 0, 1.25); g.add(chair);
    // status glow + ring on the floor
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 5), new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: '#8792a3', opacity: 0.2 }));
    glow.rotation.x = -Math.PI / 2; glow.position.set(0, 0.04, 0.9);
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.0, 1.08, 48), new THREE.MeshBasicMaterial({ color: '#8792a3', transparent: true, opacity: 0.7, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.scale.set(2.0, 1.55, 1); ring.position.set(0, 0.05, 0.9);
    g.add(glow, ring);
    // perf: keyboard / mouse / mug / monitor stand are too small to need shadows
    const noShadow = new Set([glow, ring, screen, kb, mouse, mug, stand]);
    g.traverse((m) => { if (m.isMesh && !noShadow.has(m)) { m.castShadow = true; m.receiveShadow = true; } });
    return { group: g, glow, ring, screenMat: smat, stex, sctx: sc.getContext('2d') };
  }

  const skins = ['#f1c9a0', '#e0ac7e', '#c58c5e', '#8d5a3a'];
  const hairs = ['#2b1d12', '#4a3020', '#1a1a1f', '#7a4a22', '#c9a050'];
  const pantsMat = new THREE.MeshStandardMaterial({ color: '#262d3b', roughness: 0.8 });
  const shoeMat = new THREE.MeshStandardMaterial({ color: '#12151c', roughness: 0.6 });
  const eyeMat = new THREE.MeshBasicMaterial({ color: '#141922' });

  function buildCharacter(role, id) {
    const h = hash(id);
    const skin = new THREE.MeshStandardMaterial({ color: skins[h % skins.length], roughness: 0.7 });
    const hair = new THREE.MeshStandardMaterial({ color: hairs[(h >>> 3) % hairs.length], roughness: 0.85 });
    const shirt = new THREE.MeshStandardMaterial({ color: ROLE_COLOR[role] || '#8792a3', roughness: 0.65, emissive: '#000', emissiveIntensity: 0 });
    const root = new THREE.Group();
    const body = new THREE.Group(); root.add(body);
    const upper = new THREE.Group(); upper.position.y = 0.8; body.add(upper);

    const legs = [1, -1].map((s) => {
      const piv = new THREE.Group(); piv.position.set(0.17 * s, 0.8, 0);
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.72, 0.26), pantsMat); leg.position.y = -0.38;
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.12, 0.38), shoeMat); shoe.position.set(0, -0.76, 0.06);
      piv.add(leg, shoe); body.add(piv); return piv;
    });
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.42, 4, 10), shirt);
    torso.position.y = 0.42; torso.scale.set(1.15, 1, 0.8); upper.add(torso);
    const badge = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.03), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
    badge.position.set(0.14, 0.58, 0.23); upper.add(badge);
    const arms = [1, -1].map((s) => {
      const piv = new THREE.Group(); piv.position.set(0.44 * s, 0.7, 0);
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.4, 3, 8), shirt); arm.position.y = -0.3;
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 6), skin); hand.position.y = -0.64;
      piv.add(arm, hand); upper.add(piv); piv.userData.s = s; return piv;
    });
    const head = new THREE.Group(); head.position.y = 1.2; upper.add(head);
    head.add(new THREE.Mesh(new THREE.SphereGeometry(0.3, 14, 10), skin));
    [-0.105, 0.105].forEach((x) => { const e = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 5), eyeMat); e.position.set(x, 0.04, 0.27); head.add(e); });

    if (role === 'engineer') {                       // blue hard hat
      const mat = new THREE.MeshStandardMaterial({ color: '#4f9cf9', roughness: 0.4 });
      const dome = new THREE.Mesh(new THREE.SphereGeometry(0.34, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat); dome.position.y = 0.08;
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.04, 14, 1, false, -Math.PI / 2, Math.PI), mat); brim.position.set(0, 0.08, 0.06);
      const ridge = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.06, 0.6), mat); ridge.position.y = 0.4;
      head.add(dome, brim, ridge);
    } else if (role === 'ceo') {                     // gold crown over neat hair
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.315, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), hair); cap.position.y = 0.02; cap.rotation.x = -0.25; head.add(cap);
      const gold = new THREE.MeshStandardMaterial({ color: '#fbbf24', metalness: 0.7, roughness: 0.3, emissive: '#7a5200', emissiveIntensity: 0.5 });
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.27, 0.14, 10), gold); band.position.y = 0.36; head.add(band);
      for (let i = 0; i < 5; i++) {
        const sp = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.16, 4), gold);
        const a = (i / 5) * Math.PI * 2; sp.position.set(Math.cos(a) * 0.23, 0.5, Math.sin(a) * 0.23); head.add(sp);
      }
    } else {                                         // QA: purple headphones + hair
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.315, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), hair); cap.position.y = 0.02; cap.rotation.x = -0.25; head.add(cap);
      const pm = new THREE.MeshStandardMaterial({ color: '#a78bfa', roughness: 0.4 });
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.035, 6, 20, Math.PI), pm); band.position.y = 0.02; head.add(band);
      [-1, 1].forEach((s) => { const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.1, 10), pm); cup.rotation.z = Math.PI / 2; cup.position.set(0.34 * s, 0.02, 0); head.add(cup); });
    }
    root.traverse((m) => { if (m.isMesh) m.castShadow = m !== badge && m.material !== eyeMat; });
    return { root, body, upper, legs, arms, head, shirt };
  }

  function nameTag(A) {
    const tex = canvasTex(320, 96, (g, w, h) => {
      const col = STATUS_COLOR[A.status] || '#8792a3';
      g.fillStyle = 'rgba(10,14,20,.86)';
      g.beginPath(); g.roundRect(4, 4, w - 8, h - 8, 22); g.fill();
      g.strokeStyle = col; g.lineWidth = 3; g.stroke();
      g.textAlign = 'center'; g.fillStyle = '#eef2f8'; g.font = '600 32px system-ui, sans-serif';
      g.fillText(A.name || A.id, w / 2, 42, w - 36);
      g.fillStyle = col; g.font = '500 22px system-ui, sans-serif';
      g.fillText('● ' + A.status + (A.role ? '  ·  ' + (ROLE_LABEL[A.role] || A.role) : ''), w / 2, 72, w - 36);
    });
    return tex;
  }

  function drawScreen(A, t) {
    const g = A.d.sctx, W = 128, H = 80, st = A.status;
    g.globalAlpha = 1;
    g.fillStyle = '#04070c'; g.fillRect(0, 0, W, H);
    let intensity = 1;
    if (st === 'working' || st === 'thinking') {
      g.fillStyle = st === 'working' ? '#4f9cf9' : '#fbbf24';
      const f = Math.floor(t * 5);
      for (let i = 0; i < 8; i++) {
        const sd = (i + f) % 9, ind = (sd % 3) * 9, w = 22 + ((sd * 37 + i * 11) % 66);
        g.globalAlpha = 0.45 + 0.55 * (((i * 5 + f) % 4) / 3);
        g.fillRect(8 + ind, 5 + i * 9, Math.min(w, W - 16 - ind), 4);
      }
      g.globalAlpha = 1;
      if (st === 'thinking') intensity = 0.7;
    } else if (st === 'testing') {
      const f = Math.floor(t * 6);
      for (let i = 0; i < 6; i++) {
        const ok = ((i * 7 + f) % 5) !== 0;
        g.fillStyle = ok ? '#a78bfa' : '#e4d8ff';
        g.fillRect(10, 6 + i * 12, 8, 8);
        g.fillStyle = ok ? '#34d399' : '#f87171';
        g.fillRect(24, 8 + i * 12, 24 + ((i * 29 + f * 13) % 70), 4);
      }
      intensity = 0.8 + 0.4 * Math.abs(Math.sin(t * 8));
    } else if (st === 'blocked') {
      g.fillStyle = '#4a0f12'; g.fillRect(0, 0, W, H);
      g.fillStyle = '#f87171'; g.font = 'bold 56px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('!', W / 2, H / 2 + 3);
      intensity = Math.sin(t * 5) > 0 ? 1 : 0.35;
    } else if (st === 'done') {
      g.fillStyle = '#34d399'; g.font = 'bold 54px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('✓', W / 2, H / 2 + 3);
      intensity = 0.85;
    } else {                                         // idle / waiting: screen off
      g.fillStyle = '#0a111b'; g.fillRect(0, 0, W, H);
      intensity = 0.12;
    }
    A.d.screenMat.emissiveIntensity = intensity;
    A.d.stex.needsUpdate = true;
  }

  /* ---------------- particles ---------------- */
  const MAXP = 900;
  const pPos = new Float32Array(MAXP * 3).fill(-1000), pCol = new Float32Array(MAXP * 3);
  const pBase = new Float32Array(MAXP * 3), pVel = new Float32Array(MAXP * 3), pLife = new Float32Array(MAXP), pMax = new Float32Array(MAXP);
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
  const points = new THREE.Points(pGeo, new THREE.PointsMaterial({ size: 0.32, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  points.frustumCulled = false;
  points.visible = false;
  scene.add(points);
  let pCursor = 0;
  let pActive = false;     // perf: skip the 900-slot loop, buffer uploads and the draw call when nothing is alive
  const tmpC = new THREE.Color();
  function burst(pos, color, n, speed = 4, up = 4, life = 1.2) {
    const colors = Array.isArray(color) ? color : [color];
    pActive = points.visible = true;
    for (let i = 0; i < n; i++) {
      const k = pCursor = (pCursor + 1) % MAXP;
      const a = Math.random() * Math.PI * 2, sp = speed * (0.3 + Math.random() * 0.7);
      pPos[k * 3] = pos.x; pPos[k * 3 + 1] = pos.y; pPos[k * 3 + 2] = pos.z;
      pVel[k * 3] = Math.cos(a) * sp; pVel[k * 3 + 1] = up * (0.5 + Math.random()); pVel[k * 3 + 2] = Math.sin(a) * sp;
      tmpC.set(colors[i % colors.length]);
      pBase[k * 3] = tmpC.r; pBase[k * 3 + 1] = tmpC.g; pBase[k * 3 + 2] = tmpC.b;
      pLife[k] = pMax[k] = life * (0.6 + Math.random() * 0.6);
    }
  }
  function updateParticles(dt) {
    if (!pActive) return;
    let alive = 0;
    for (let k = 0; k < MAXP; k++) {
      if (pLife[k] <= 0) continue;
      pLife[k] -= dt;
      if (pLife[k] <= 0) { pPos[k * 3 + 1] = -1000; continue; }
      alive++;
      pVel[k * 3 + 1] -= 9 * dt;
      pPos[k * 3] += pVel[k * 3] * dt; pPos[k * 3 + 1] += pVel[k * 3 + 1] * dt; pPos[k * 3 + 2] += pVel[k * 3 + 2] * dt;
      if (pPos[k * 3 + 1] < 0.05) { pPos[k * 3 + 1] = 0.05; pVel[k * 3 + 1] *= -0.3; pVel[k * 3] *= 0.8; pVel[k * 3 + 2] *= 0.8; }
      const f = pLife[k] / pMax[k];
      pCol[k * 3] = pBase[k * 3] * f; pCol[k * 3 + 1] = pBase[k * 3 + 1] * f; pCol[k * 3 + 2] = pBase[k * 3 + 2] * f;
    }
    pGeo.attributes.position.needsUpdate = true;
    pGeo.attributes.color.needsUpdate = true;
    pActive = points.visible = alive > 0;
  }

  /* ---------------- building ---------------- */
  const bld = new THREE.Group(); bld.position.set(BX, 0, BZ); scene.add(bld);
  const plot = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.MeshStandardMaterial({ color: '#1a1f29', roughness: 1 }));
  plot.rotation.x = -Math.PI / 2; plot.position.y = 0.03; plot.receiveShadow = true; bld.add(plot);
  const outline = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([[-3.6, 0.06, -3.6], [3.6, 0.06, -3.6], [3.6, 0.06, 3.6], [-3.6, 0.06, 3.6]].map((p) => new THREE.Vector3(...p))),
    new THREE.LineDashedMaterial({ color: '#fbbf24', dashSize: 0.5, gapSize: 0.3 })
  );
  outline.computeLineDistances(); bld.add(outline);
  const slab = new THREE.Mesh(new THREE.BoxGeometry(5.6, 0.3, 5.6), new THREE.MeshStandardMaterial({ color: '#4a525f', roughness: 0.95 }));
  slab.position.y = 0.15; slab.castShadow = slab.receiveShadow = true; bld.add(slab);

  function facade(seed) {
    return canvasTex(128, 128, (g, w, h) => {
      g.fillStyle = seed ? '#3d4c63' : '#46586e'; g.fillRect(0, 0, w, h);
      let s = 11 + seed * 5; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
      for (let c = 0; c < 4; c++) {
        g.fillStyle = r() > 0.3 ? '#ffd88a' : '#1a2230';
        g.fillRect(10 + c * 29, 28, 20, 70);
      }
    });
  }
  const mkFace = (seed) => { const t = facade(seed); return new THREE.MeshStandardMaterial({ map: t, emissive: '#fff', emissiveMap: t, emissiveIntensity: 0.35, roughness: 0.7 }); };
  const faces = [mkFace(0), mkFace(1)];
  const capMat = new THREE.MeshStandardMaterial({ color: '#2a3140', roughness: 0.8 });
  const FLOOR_H = 1.25, MAX_FLOORS = 40;
  const floorMeshes = [];
  const roof = new THREE.Group();
  const roofSlab = new THREE.Mesh(new THREE.BoxGeometry(5.3, 0.25, 5.3), capMat); roofSlab.castShadow = true;
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 2, 6), lampMetal); mast.position.y = 1.1;
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), new THREE.MeshBasicMaterial({ color: '#f87171' })); beacon.position.y = 2.15;
  roof.add(roofSlab, mast, beacon); roof.visible = false; bld.add(roof);

  // build-site: crane + sign
  const site = new THREE.Group(); bld.add(site);
  const yellow = new THREE.MeshStandardMaterial({ color: '#f5b301', roughness: 0.5 });
  const tower = new THREE.Mesh(new THREE.BoxGeometry(0.3, 9, 0.3), yellow); tower.position.set(2.8, 4.5, 2.8);
  const jib = new THREE.Mesh(new THREE.BoxGeometry(6.5, 0.25, 0.25), yellow); jib.position.set(0.4, 9.1, 2.8);
  const cw = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 0.5), lampMetal); cw.position.set(3.7, 8.7, 2.8);
  const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 4, 4), lampMetal); cable.position.set(-1.6, 7.0, 2.8);
  const hook = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 0.4), yellow); hook.position.set(-1.6, 5.0, 2.8);
  site.add(tower, jib, cw, cable, hook);
  const signTex = canvasTex(256, 96, (g, w, h) => {
    g.fillStyle = '#f5b301'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#111'; g.font = 'bold 34px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('🏗 BUILD SITE', w / 2, h / 2 + 2);
  });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.97), new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.6 }));
  sign.position.set(-2.4, 1.2, 3.65); site.add(sign);
  [-3.5, -1.3].forEach((x) => { const p = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.3, 0.1), lampMetal); p.position.set(x, 0.65, 3.6); site.add(p); });
  site.traverse((m) => { if (m.isMesh) m.castShadow = true; });

  const bTag = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false }));
  bTag.renderOrder = 10; bTag.scale.set(3.4, 1.0, 1); bld.add(bTag);
  let bTagFloors = -1, builtFloors = 0, roofY = 0.3 + FLOOR_H * 0 ;
  const roofTarget = () => 0.3 + builtFloors * FLOOR_H;

  function setBTag(n) {
    if (bTagFloors === n) return;
    bTagFloors = n;
    if (bTag.material.map) bTag.material.map.dispose();
    bTag.material.map = canvasTex(320, 96, (g, w, h) => {
      g.fillStyle = 'rgba(10,14,20,.86)'; g.beginPath(); g.roundRect(4, 4, w - 8, h - 8, 22); g.fill();
      g.strokeStyle = '#7cb2ff'; g.lineWidth = 3; g.stroke();
      g.fillStyle = '#eef2f8'; g.font = '600 34px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('🏢 ' + n + (n === 1 ? ' floor' : ' floors'), w / 2, h / 2 + 2);
    });
    bTag.material.needsUpdate = true;
  }

  function setFloors(n, animate) {
    n = clamp(n | 0, 0, MAX_FLOORS);
    while (builtFloors < n) {
      const i = builtFloors++;
      const m = new THREE.Mesh(new THREE.BoxGeometry(5, FLOOR_H - 0.05, 5), [faces[i % 2], faces[i % 2], capMat, capMat, faces[(i + 1) % 2], faces[(i + 1) % 2]]);
      m.castShadow = m.receiveShadow = true;
      m.userData.y = 0.3 + i * FLOOR_H + FLOOR_H / 2;
      m.userData.anim = animate ? 0 : 1;
      m.position.y = animate ? m.userData.y + 9 : m.userData.y;
      bld.add(m); floorMeshes.push(m);
    }
    while (builtFloors > n) { const m = floorMeshes.pop(); bld.remove(m); m.geometry.dispose(); builtFloors--; }
    roof.visible = n > 0; site.visible = n === 0;
    setBTag(n);
  }

  function updateBuilding(dt, t) {
    floorMeshes.forEach((m) => {
      const u = m.userData;
      if (u.anim < 1) {
        u.anim = Math.min(1, u.anim + dt / 0.9);
        const e = 1 - Math.pow(1 - u.anim, 3);
        m.position.y = u.y + (1 - e) * 9;
        if (u.anim >= 1) {
          const p = new THREE.Vector3(BX, u.y + 0.8, BZ);
          burst(p, ['#fbbf24', '#7cb2ff', '#34d399', '#f87171', '#a78bfa', '#ffffff'], 70, 5.5, 6, 1.8);
        }
      }
    });
    const topAnim = floorMeshes.length ? floorMeshes[floorMeshes.length - 1].userData.anim : 1;
    const ty = roofTarget();
    roofY = lerp(roofY, ty, Math.min(1, dt * 6));
    roof.position.y = topAnim < 1 ? ty + 20 : roofY + 0.12;
    if (topAnim >= 1) roof.position.y = roofY + 0.12;
    bTag.position.y = (roof.visible ? roofY : 0) + 4.4;
    const on = Math.sin(t * 4) > 0;
    if (on !== beaconOn) { beaconOn = on; beacon.material.color.set(on ? '#f87171' : '#5a2020'); }
    if (site.visible) { hook.position.y = 5 + Math.sin(t * 1.3) * 0.4; cable.position.y = 7.0 + Math.sin(t * 1.3) * 0.2; }
  }
  let beaconOn = true;

  /* ---------------- day / night ---------------- */
  const C = (c) => new THREE.Color(c);
  const MOOD = {
    night: {
      bg: C('#080b11'), ground: C('#06080c'), amb: C(0x8a96b8), ambI: 0.35, sky: C(0x9db8ff), gnd: C(0x3a2a1c), hemiI: 0.5,
      key: C(0xcfe0ff), keyI: 1.15, keyPos: new THREE.Vector3(-16, 26, 14), fill: C(0xffd2a0), fillI: 0.4,
      lamp: 55, shade: 1.1, bulb: C('#fff0cc'), pane: 0.75, facade: 0.35, exposure: 1.05,
    },
    day: {
      bg: C('#8fb8de'), ground: C('#4d5a46'), amb: C(0xfff4e2), ambI: 0.6, sky: C(0xcfe6ff), gnd: C(0x6b5a44), hemiI: 0.8,
      key: C(0xfff0d8), keyI: 2.1, keyPos: new THREE.Vector3(-10, 30, 18), fill: C(0xcfe2ff), fillI: 0.55,
      lamp: 0, shade: 0.2, bulb: C('#c9c2b0'), pane: 0.95, facade: 0.06, exposure: 1.0,
    },
  };
  const MOOD_SECS = 1.5;
  let dayK = isDay ? 1 : 0, dayTarget = dayK;
  function applyMood(k) {
    const N = MOOD.night, D = MOOD.day, e = k * k * (3 - 2 * k);
    scene.background.lerpColors(N.bg, D.bg, e);
    scene.fog.color.copy(scene.background);
    groundMat.color.lerpColors(N.ground, D.ground, e);
    ambient.color.lerpColors(N.amb, D.amb, e); ambient.intensity = lerp(N.ambI, D.ambI, e);
    hemi.color.lerpColors(N.sky, D.sky, e); hemi.groundColor.lerpColors(N.gnd, D.gnd, e); hemi.intensity = lerp(N.hemiI, D.hemiI, e);
    key.color.lerpColors(N.key, D.key, e); key.intensity = lerp(N.keyI, D.keyI, e); key.position.lerpVectors(N.keyPos, D.keyPos, e);
    fill.color.lerpColors(N.fill, D.fill, e); fill.intensity = lerp(N.fillI, D.fillI, e);
    lampLights.forEach((l) => { l.intensity = lerp(N.lamp, D.lamp, e); });
    shadeMat.emissiveIntensity = lerp(N.shade, D.shade, e);
    bulbMat.color.lerpColors(N.bulb, D.bulb, e);
    faces.forEach((f) => { f.emissiveIntensity = lerp(N.facade, D.facade, e); });
    // window view: swap the cached sky at the midpoint, dimming the panes around it so the swap reads as a fade
    paneMat.emissiveMap = e < 0.5 ? skyNight : skyDay;
    paneMat.emissiveIntensity = lerp(N.pane, D.pane, e) * (0.15 + 0.85 * Math.abs(2 * e - 1));
    renderer.toneMappingExposure = lerp(N.exposure, D.exposure, e);
  }
  applyMood(dayK);
  function setDay(on) { dayTarget = on ? 1 : 0; }
  function updateMood(dt) {
    if (dayK === dayTarget) return;                  // perf: idle unless a transition is running
    const step = dt / MOOD_SECS;
    dayK = dayTarget > dayK ? Math.min(dayTarget, dayK + step) : Math.max(dayTarget, dayK - step);
    applyMood(dayK);
  }

  /* ---------------- actors ---------------- */
  const actors = new Map();
  const actorRoots = [];
  const bubblesEl = $('bubbles');

  function deskPos(a, i, n) {
    const nx = Number.isFinite(a.desk_x) ? a.desk_x : (i + 0.5) / Math.max(n, 1);
    const ny = Number.isFinite(a.desk_y) ? a.desk_y : 0.5;
    return new THREE.Vector3(-16 + clamp(nx, 0, 1) * 26, 0, -9.5 + clamp(ny, 0, 1) * 15);
  }

  function makeActor(a) {
    const A = {
      id: a.id, role: a.role, name: a.name, status: a.status || 'idle', task: a.current_task || '',
      phase: Math.random() * 6.28, sit: 0, yaw: 0, walkT: 0, moving: false, nextWander: 0,
      pos: new THREE.Vector3(), target: new THREE.Vector3(), desk: new THREE.Vector3(),
      pose: { legL: 0, legR: 0, armL: 0, armR: 0, spreadL: 0.1, spreadR: 0.1, lean: 0, headX: 0, headY: 0, headZ: 0, bodyY: 0, swayZ: 0 },
      screenT: 0, dirty: true, tagStatus: null, icon: null,
    };
    A.d = buildDesk(); scene.add(A.d.group);
    A.tag = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false })); A.tag.renderOrder = 11; A.tag.scale.set(3.3, 0.99, 1);
    A.iconSpr = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false })); A.iconSpr.renderOrder = 12; A.iconSpr.scale.set(0.95, 0.95, 1);
    A.sel = new THREE.Mesh(new THREE.RingGeometry(0.75, 0.9, 32), new THREE.MeshBasicMaterial({ color: '#7cb2ff', transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
    A.sel.rotation.x = -Math.PI / 2; A.sel.position.y = 0.07; A.sel.visible = false;
    attachChar(A);
    scene.add(A.tag, A.iconSpr);
    return A;
  }

  function attachChar(A) {
    if (A.ch) { scene.remove(A.ch.root); const i = actorRoots.indexOf(A.ch.root); if (i >= 0) actorRoots.splice(i, 1); }
    A.ch = buildCharacter(A.role, A.id);
    A.builtRole = A.role;
    A.ch.root.userData.actorId = A.id;
    A.ch.root.add(A.sel);
    scene.add(A.ch.root); actorRoots.push(A.ch.root);
  }

  function layoutActor(A, p, first) {
    A.desk.copy(p);
    A.d.group.position.copy(p);
    A.seat = new THREE.Vector3(p.x, 0, p.z + 1.15);
    A.stand = new THREE.Vector3(p.x, 0, p.z + 2.9);
    if (first) {
      A.pos.copy(SEATED.has(A.status) ? A.seat : A.stand.clone().add(new THREE.Vector3((Math.random() - 0.5) * 3, 0, (Math.random() - 0.5) * 1.5)));
      A.sit = SEATED.has(A.status) ? 1 : 0;
      A.yaw = SEATED.has(A.status) ? Math.PI : 0;
      A.target.copy(A.pos);
    }
  }

  function syncActors(list) {
    const seen = new Set();
    list.forEach((a, i) => {
      seen.add(a.id);
      let A = actors.get(a.id);
      const p = deskPos(a, i, list.length);
      if (!A) {
        A = makeActor(a); actors.set(a.id, A);
        layoutActor(A, p, true);
      } else if (!A.desk.equals(p)) layoutActor(A, p, false);
      A.name = a.name; A.task = a.current_task || '';
      if (a.role !== A.role) { A.role = a.role; attachChar(A); A.dirty = true; }
      const st = a.status || 'idle';
      if (st !== A.status) {
        A.status = st; A.dirty = true;
        if (st === 'done') burst(A.pos.clone().setY(2.6), '#34d399', 18, 3, 4, 1.0);
        if (!SEATED.has(st)) A.nextWander = 0;
      }
    });
    for (const [id, A] of actors) {
      if (!seen.has(id)) {
        scene.remove(A.ch.root, A.d.group, A.tag, A.iconSpr);
        const k = actorRoots.indexOf(A.ch.root); if (k >= 0) actorRoots.splice(k, 1);
        disposeActor(A);
        actors.delete(id);
        if (followId === id) unfollow();
      }
    }
  }

  // project switches remove a whole team; free its per-actor GPU buffers (shared materials are left alone)
  function disposeActor(A) {
    [A.ch.root, A.d.group].forEach((g) => g.traverse((m) => { if (m.geometry) m.geometry.dispose(); }));
    A.d.stex.dispose();
    if (A.tag.material.map) A.tag.material.map.dispose();
    A.tag.material.dispose(); A.iconSpr.material.dispose();
  }

  const FLOOR_X = FW / 2 - 2, FLOOR_Z = FD / 2 - 2;
  const SCREEN_DT = 0.28;
  const angDiff = (a, b) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };

  function updateActor(A, dt, t) {
    const st = A.status, wantSeat = SEATED.has(st);
    // pick a target
    if (wantSeat) A.target.copy(A.seat);
    else if (st === 'thinking' || st === 'done') A.target.copy(A.stand);
    else if (t > A.nextWander) {
      const near = A.pos.distanceTo(A.target) < 0.1;
      if (near || A.nextWander === 0) {
        A.target.set(A.stand.x + (Math.random() - 0.5) * 6, 0, A.stand.z + (Math.random() - 0.3) * 3);
        A.target.x = clamp(A.target.x, -FLOOR_X, FLOOR_X - 6); A.target.z = clamp(A.target.z, -FLOOR_Z, FLOOR_Z);
        A.nextWander = t + 3 + Math.random() * 6;
      }
    }
    const dx = A.target.x - A.pos.x, dz = A.target.z - A.pos.z, dist = Math.hypot(dx, dz);
    A.moving = false;
    let wantYaw = A.yaw;
    if (dist > 0.06) {
      if (A.sit > 0.05) A.sit = Math.max(0, A.sit - dt * 3);         // stand up first
      else {
        const step = Math.min(dist, 3.6 * dt);
        A.pos.x += (dx / dist) * step; A.pos.z += (dz / dist) * step;
        A.moving = true; wantYaw = Math.atan2(dx, dz);
        A.walkT += dt * 9;
      }
    } else {
      A.pos.x = A.target.x; A.pos.z = A.target.z;
      if (wantSeat) { wantYaw = Math.PI; A.sit = Math.min(1, A.sit + dt * 3); }
      else { wantYaw = 0.0 + Math.sin(t * 0.3 + A.phase) * 0.35; A.sit = Math.max(0, A.sit - dt * 3); }
    }
    A.yaw += angDiff(A.yaw, wantYaw) * Math.min(1, dt * 10);

    // pose targets
    const T = { legL: 0, legR: 0, armL: 0, armR: 0, spreadL: 0.12, spreadR: 0.12, lean: 0, headX: 0, headY: 0, headZ: 0, bodyY: 0, swayZ: 0 };
    const ph = A.phase, sit = A.sit;
    if (A.moving) {
      const s = Math.sin(A.walkT);
      T.legL = s * 0.7; T.legR = -s * 0.7; T.armL = -s * 0.6; T.armR = s * 0.6; T.bodyY = Math.abs(Math.cos(A.walkT)) * 0.07; T.lean = 0.06;
    } else if (sit > 0.5) {
      T.legL = T.legR = -1.5; T.bodyY = -0.18;
      const rate = st === 'testing' ? 18 : 14;
      if (st === 'blocked') {
        T.lean = 0.5; T.headX = 0.35; T.armL = T.armR = -0.3; T.spreadL = T.spreadR = 0.25; T.swayZ = Math.sin(t * 1.5 + ph) * 0.03;
      } else {
        T.armL = -1.25 + Math.sin(t * rate + ph) * 0.1; T.armR = -1.25 + Math.sin(t * rate + ph + 2.1) * 0.1;
        T.spreadL = T.spreadR = -0.05; T.lean = 0.08;
        T.headX = st === 'testing' ? 0.08 + Math.sin(t * 6) * 0.05 : 0.05;
        T.headY = Math.sin(t * 1.3 + ph) * 0.1;
      }
    } else if (st === 'thinking') {
      T.armL = -2.35; T.spreadL = -0.35; T.armR = -1.3; T.spreadR = -0.45;   // hand on chin, other arm propping elbow
      T.headZ = 0.12; T.headX = -0.05; T.headY = Math.sin(t * 0.8 + ph) * 0.25; T.swayZ = Math.sin(t * 1.4 + ph) * 0.04;
    } else if (st === 'done') {
      T.armL = -3.0 + Math.sin(t * 7) * 0.2; T.armR = -3.0 - Math.sin(t * 7) * 0.2; T.spreadL = T.spreadR = 0.3;
      T.bodyY = Math.abs(Math.sin(t * 5 + ph)) * 0.14; T.headX = -0.15;
    } else {                                                                   // idle / waiting
      T.swayZ = Math.sin(t * 1.2 + ph) * 0.03;
      T.headY = Math.sin(t * 0.7 + ph) * 0.6 * Math.sin(t * 0.23 + ph);
      T.armL = Math.sin(t * 1.2 + ph) * 0.05; T.armR = -T.armL;
      if (st === 'waiting') { T.legR = Math.max(0, Math.sin(t * 6 + ph)) * 0.18; T.armL = -0.9; T.spreadL = -0.5; T.headY *= 0.5; }
    }
    // blend seated legs smoothly while standing/sitting
    const kk = Math.min(1, dt * 12), P = A.pose;
    for (const k in T) P[k] += (T[k] - P[k]) * kk;
    const c = A.ch;
    c.legs[0].rotation.x = P.legL; c.legs[1].rotation.x = P.legR;
    c.arms[0].rotation.set(P.armL, 0, P.spreadL);
    c.arms[1].rotation.set(P.armR, 0, -P.spreadR);
    c.upper.rotation.x = P.lean;
    c.head.rotation.set(P.headX, P.headY, P.headZ);
    c.body.position.y = P.bodyY;
    c.body.rotation.z = P.swayZ;
    c.root.position.copy(A.pos); c.root.rotation.y = A.yaw;

    // status colors only change with the status (perf: no per-frame Color.set string parsing)
    const act = st !== 'idle';
    if (A.dirty) {
      const col = STATUS_COLOR[st] || '#8792a3';
      A.d.glow.material.color.set(col); A.d.ring.material.color.set(col);
      A.d.ring.material.opacity = act ? 0.8 : 0.35;
      if (!act) A.d.glow.material.opacity = 0.1;
      c.shirt.emissive.set(st === 'blocked' ? '#ff2a2a' : '#000');   // blocked glow on shirt
      if (st !== 'blocked') c.shirt.emissiveIntensity = 0;
    }
    if (st === 'blocked') c.shirt.emissiveIntensity = 0.25 + 0.2 * Math.sin(t * 4);
    if (act) A.d.glow.material.opacity = 0.3 + 0.12 * Math.sin(t * 3 + ph);
    // perf: animated screens re-upload their texture ~3.5x/s (was ~8x/s); static ones only on change.
    // The random back-dating staggers uploads so agents that changed together don't redraw on the same frame.
    const animated = st === 'working' || st === 'thinking' || st === 'testing' || st === 'blocked';
    if (A.dirty || (animated && t - A.screenT > SCREEN_DT)) { drawScreen(A, t); A.screenT = t - (A.dirty ? Math.random() * SCREEN_DT : 0); }

    // tag + icon
    if (A.tagStatus !== st + '|' + A.name + '|' + A.role) {
      A.tagStatus = st + '|' + A.name + '|' + A.role;
      if (A.tag.material.map) A.tag.material.map.dispose();
      A.tag.material.map = nameTag(A); A.tag.material.needsUpdate = true;
    }
    const ic = A.moving ? '🚶' : STATUS_ICON[st] || '🙂';
    if (A.icon !== ic) { A.icon = ic; A.iconSpr.material.map = getEmojiTex(ic); A.iconSpr.material.needsUpdate = true; }
    const hy = 2.95 - (sit > 0.5 ? 0.18 : 0);
    A.tag.position.set(A.pos.x, hy + 0.95, A.pos.z);
    A.iconSpr.position.set(A.pos.x, hy + 0.1 + Math.sin(t * 3 + ph) * 0.08, A.pos.z);
    A.dirty = false;
    A.sel.visible = followId === A.id;
    if (A.sel.visible) { A.sel.rotation.z = t; A.sel.scale.setScalar(1 + 0.06 * Math.sin(t * 4)); }
  }

  /* ---------------- speech bubbles (HTML overlay, projected) ---------------- */
  const bubbles = [];
  function say(agentId, text, type) {
    const A = actors.get(agentId); if (!A) return;
    for (let i = bubbles.length - 1; i >= 0; i--) if (bubbles[i].id === agentId) { bubbles[i].el.remove(); bubbles.splice(i, 1); }
    const el = document.createElement('div');
    el.className = 'bubble ' + (type || 'info');
    el.style.setProperty('--c', EVENT_COLOR[type] || EVENT_COLOR.info);
    el.textContent = String(text).length > 110 ? String(text).slice(0, 107) + '…' : text;
    bubblesEl.appendChild(el);
    bubbles.push({ id: agentId, el, until: performance.now() / 1000 + 4.5 });
  }
  function clearBubbles() { bubbles.splice(0).forEach((b) => b.el.remove()); }
  const tmpV = new THREE.Vector3();
  let viewW = 1, viewH = 1;                          // cached in resize() (no per-frame layout reads)
  function updateBubbles(now) {
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const b = bubbles[i], A = actors.get(b.id), left = b.until - now;
      if (left <= 0 || !A) { b.el.remove(); bubbles.splice(i, 1); continue; }
      tmpV.set(A.pos.x, 4.7, A.pos.z).project(camera);
      // perf: only touch the DOM when a value actually changed (static camera + idle agent = zero writes)
      const disp = tmpV.z < 1 && tmpV.z > -1 ? '' : 'none';
      if (b.disp !== disp) { b.disp = disp; b.el.style.display = disp; }
      if (disp) continue;
      const tf = `translate(${((tmpV.x + 1) / 2 * viewW).toFixed(1)}px, ${((1 - tmpV.y) / 2 * viewH).toFixed(1)}px) translate(-50%, -100%)`;
      if (b.tf !== tf) { b.tf = tf; b.el.style.transform = tf; }
      const op = clamp(left / 0.6, 0, 1).toFixed(2);
      if (b.op !== op) { b.op = op; b.el.style.opacity = op; }
    }
  }

  /* ---------------- camera: follow / reset ---------------- */
  const FOLLOW_DIST = 14;
  let zoomPending = false, tween = null, usableAspect = 0;
  function homeView() {
    const aspect = usableAspect || camera.aspect || 1.6;
    const dist = clamp(Math.max(40, 72 / aspect), 40, 90);
    const dir = new THREE.Vector3(0, 0.7, 0.72).normalize();
    return { pos: HOME_TARGET.clone().addScaledVector(dir, dist), target: HOME_TARGET.clone() };
  }
  function resetView() {
    unfollow();
    const v = homeView();
    tween = { t: 0, p0: camera.position.clone(), p1: v.pos, t0: controls.target.clone(), t1: v.target };
  }
  function follow(id) {
    if (!actors.has(id)) return;
    followId = id; zoomPending = true; tween = null;
    updateFollowUi();
  }
  function unfollow() { followId = null; zoomPending = false; updateFollowUi(); }
  controls.addEventListener('start', () => { tween = null; zoomPending = false; });

  function updateCamera(dt) {
    if (tween) {
      tween.t = Math.min(1, tween.t + dt / 1.1);
      const e = tween.t * tween.t * (3 - 2 * tween.t);
      camera.position.lerpVectors(tween.p0, tween.p1, e);
      controls.target.lerpVectors(tween.t0, tween.t1, e);
      if (tween.t >= 1) tween = null;
    } else if (followId) {
      const A = actors.get(followId);
      if (A) {
        const want = tmpV.set(A.pos.x, 1.4, A.pos.z);
        const d = want.clone().sub(controls.target).multiplyScalar(1 - Math.exp(-dt * 4));
        controls.target.add(d); camera.position.add(d);
        if (zoomPending) {
          const off = camera.position.clone().sub(controls.target), len = off.length();
          const nl = len + (FOLLOW_DIST - len) * (1 - Math.exp(-dt * 3));
          camera.position.copy(controls.target).add(off.setLength(nl));
          if (Math.abs(nl - FOLLOW_DIST) < 0.3) zoomPending = false;
        }
      }
    }
    controls.update();
  }

  /* ---------------- picking ---------------- */
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function pickActor(e) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(actorRoots, true)[0];
    if (!hit) return null;
    let o = hit.object;
    while (o && !o.userData.actorId) o = o.parent;
    return o ? o.userData.actorId : null;
  }
  let down = null;
  const dom = renderer.domElement;
  dom.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  dom.addEventListener('pointercancel', () => { down = null; });
  dom.addEventListener('pointerup', (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y); down = null;
    if (moved > 5) return;
    const id = pickActor(e);
    if (id) follow(id); else if (followId) unfollow();
  });
  let lastHover = 0;
  dom.addEventListener('pointermove', (e) => {
    const n = performance.now(); if (n - lastHover < 60 || e.buttons || down) return; lastHover = n;   // no raycasts mid-drag
    dom.style.cursor = pickActor(e) ? 'pointer' : 'grab';
  });

  /* ---------------- resize ---------------- */
  const asideEl = document.querySelector('aside');
  function resize() {
    const w = host.clientWidth || window.innerWidth, h = host.clientHeight || window.innerHeight;
    viewW = w; viewH = h;
    renderer.setPixelRatio(pixelRatio());
    renderer.setSize(w, h);
    camera.aspect = w / h;
    const open = !document.body.classList.contains('aside-closed') && w > 900;
    const shift = open ? (asideEl.getBoundingClientRect().width + 16) / 2 : 0;
    usableAspect = (w - shift * 2) / h;
    if (shift) camera.setViewOffset(w, h, shift, 0, w, h); else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);

  /* ---------------- init camera + loop ---------------- */
  resize();
  const hv = homeView();
  camera.position.copy(hv.pos); controls.target.copy(hv.target); controls.update();
  setFloors(0, false);

  const clock = new THREE.Clock();
  let t = 0;
  function frame() {
    requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05);
    t += dt;
    actors.forEach((A) => updateActor(A, dt, t));
    swayers.forEach((s) => { s.holder.rotation.z = Math.sin(t * 0.9 + s.ph) * 0.03; s.holder.rotation.x = Math.cos(t * 0.7 + s.ph) * 0.02; });
    updateBuilding(dt, t);
    updateParticles(dt);
    updateMood(dt);
    updateCamera(dt);
    updateBubbles(performance.now() / 1000);
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);

  // switching project rooms: drop the old team, its bubbles and its building
  function reset() {
    syncActors([]);
    clearBubbles();
    setFloors(0, false);
  }

  return {
    sync: syncActors, say, burst, setFloors, follow, unfollow, resetView, resize, setDay, reset,
    actorPos: (id) => { const A = actors.get(id); return A ? A.pos : null; },
    has: (id) => actors.has(id),
  };
}

/* ------------------------------------------------------------------ */
/* Follow UI                                                          */
/* ------------------------------------------------------------------ */
function updateFollowUi() {
  const hint = $('viewhint');
  document.body.classList.toggle('following', !!followId);
  if (!followId) { hint.textContent = 'Click an agent to follow · drag to orbit · scroll to zoom'; }
  else {
    const a = (state && state.agents || []).find((x) => x.id === followId);
    hint.innerHTML = 'Following <b>' + escapeHtml(a ? a.name : followId) + '</b>' + (a ? ' · ' + escapeHtml(a.status) : '') + ' — click empty space to release';
  }
  document.querySelectorAll('#roster .rrow').forEach((r) => r.classList.toggle('sel', r.dataset.id === followId));
}
function followAgent(id) {
  if (!world) return;
  if (followId === id) { world.unfollow(); return; }
  world.follow(id);
}

/* ------------------------------------------------------------------ */
/* State ingestion                                                    */
/* ------------------------------------------------------------------ */
function ingest(snap) {
  state = snap;
  const agents = snap.agents || [];
  if (world) {
    world.sync(agents);
    world.setFloors((snap.metrics && snap.metrics.floors) || 0, !firstSnapshot);
  }
  processEvents(snap.events || []);
  updateSidebar(snap);
  firstSnapshot = false;
}
window.ingest = ingest;

function processEvents(evs) {
  let maxId = lastEventId;
  evs.forEach((e) => {
    if (e.id <= lastEventId) return;
    maxId = Math.max(maxId, e.id);
    if (firstSnapshot || !world) return;            // don't replay history on load
    world.say(e.agent_id, e.message, e.type);
    const p = world.actorPos(e.agent_id);
    if (p && e.type === 'success') world.burst(p.clone().setY(2.8), '#34d399', 24, 3.5, 5, 1.1);
    if (p && e.type === 'error') world.burst(p.clone().setY(2.8), '#f87171', 24, 3.5, 5, 1.1);
  });
  lastEventId = maxId;
}

/* ------------------------------------------------------------------ */
/* Sidebar                                                            */
/* ------------------------------------------------------------------ */
const sigs = {};
const changed = (k, v) => { const s = JSON.stringify(v); if (sigs[k] === s) return false; sigs[k] = s; return true; };

function fmtTime(ts) {
  if (ts == null) return '';
  let d = typeof ts === 'number' ? new Date(ts < 1e12 ? ts * 1000 : ts) : new Date(ts);
  if (isNaN(d)) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function avatarHtml(name, color) {
  const initials = (String(name || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2) || '?').toUpperCase();
  return '<span class="avatar" style="--c:' + color + '">' + escapeHtml(initials) + '</span>';
}
function agentColor(id) {
  const a = state && (state.agents || []).find((x) => x.id === id || x.name === id);
  return a ? (ROLE_COLOR[a.role] || '#8792a3') : '#8792a3';
}

function updateSidebar(snap) {
  const agents = snap.agents || [], tasks = snap.tasks || [], m = snap.metrics || {};
  // header
  $('hdr-agents').textContent = agents.length;
  $('hdr-active').textContent = agents.filter((a) => ['working', 'testing', 'thinking'].includes(a.status)).length;
  const open = tasks.filter((t) => t.status !== 'done').length;
  $('hdr-tasks').textContent = open;
  $('hdr-floors').textContent = m.floors || 0;
  const tc = $('tab-tasks-count'); tc.textContent = open; tc.hidden = !open;
  updateMessages(snap.conversation || []);
  updateLog(snap.events || [], agents);
  updateTasks(tasks, agents);
  updateMetrics(m);
  updateRoster(agents);
  updateFollowUi();
}

const messagesEl = $('messages');
function updateMessages(conv) {
  if (!changed('msg', conv)) return;
  const stick = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
  messagesEl.innerHTML = '';
  if (!conv.length) messagesEl.innerHTML = '<div class="empty">Say hi to the CEO — describe what you want built and the team will get to work.</div>';
  conv.forEach((m) => {
    const isUser = m.speaker === 'user';
    const d = document.createElement('div');
    d.className = 'msg ' + m.speaker;
    d.innerHTML = avatarHtml(isUser ? 'You' : 'CEO', isUser ? '#7cb2ff' : '#fbbf24') +
      '<div class="mbody"><div class="mmeta"><span class="who">' + (isUser ? 'You' : 'CEO') + '</span><time>' + fmtTime(m.ts) + '</time></div>' +
      '<div class="mtext"></div></div>';
    d.querySelector('.mtext').textContent = m.message;
    messagesEl.appendChild(d);
  });
  if (stick || firstSnapshot) messagesEl.scrollTop = messagesEl.scrollHeight;
}

const logEl = $('log');
function updateLog(events, agents) {
  if (!changed('log', [events, agents.map((a) => a.name)])) return;
  logEl.innerHTML = '';
  if (!events.length) logEl.innerHTML = '<div class="empty">No activity yet.</div>';
  events.slice().reverse().forEach((e) => {
    const d = document.createElement('div');
    d.className = 'ev ' + e.type;
    d.style.setProperty('--c', EVENT_COLOR[e.type] || EVENT_COLOR.info);
    const a = agents.find((x) => x.id === e.agent_id);
    d.innerHTML = '<i class="evdot"></i><div class="evbody"><div class="evhead"><b style="color:' + agentColor(e.agent_id) + '">' +
      escapeHtml(a ? a.name : e.agent_id) + '</b><span class="evtype">' + escapeHtml(e.type) + '</span><time>' + fmtTime(e.ts) + '</time></div>' +
      '<div class="evmsg">' + escapeHtml(e.message) + '</div></div>';
    logEl.appendChild(d);
  });
}

const tasksEl = $('tasklist');
function updateTasks(tasks, agents) {
  if (!changed('tasks', [tasks, agents.map((a) => a.name)])) return;
  const counts = { todo: 0, in_progress: 0, review: 0, done: 0 };
  tasks.forEach((t) => { counts[t.status] = (counts[t.status] || 0) + 1; });
  $('tasksummary').innerHTML = ['todo', 'in_progress', 'review', 'done'].map((s) =>
    '<div class="tsum ' + s + '"><b>' + counts[s] + '</b><span>' + s.replace('_', ' ') + '</span></div>').join('');
  tasksEl.innerHTML = '';
  if (!tasks.length) { tasksEl.innerHTML = '<div class="empty">No tasks yet — talk to the CEO.</div>'; return; }
  tasks.forEach((t) => {
    const d = document.createElement('div');
    d.className = 'task ' + t.status;
    const who = t.assignee ? nameOf(t.assignee) : null;
    d.innerHTML = '<div class="t-top"><div class="t-title">' + escapeHtml(t.title) + '</div><span class="badge ' + t.status + '">' + escapeHtml(String(t.status).replace('_', ' ')) + '</span></div>' +
      (t.description ? '<div class="t-desc">' + escapeHtml(t.description) + '</div>' : '') +
      '<div class="t-meta">' + (who ? avatarHtml(who, agentColor(t.assignee)) + '<span>' + escapeHtml(who) + '</span>' : '<span class="muted">unassigned</span>') + '</div>';
    tasksEl.appendChild(d);
  });
}

const metricsEl = $('metrics');
function updateMetrics(m) {
  if (!changed('metrics', m)) return;
  const pass = m.tests_passed || 0, fail = m.tests_failed || 0, total = pass + fail;
  const items = [
    ['🏢', 'Floors', m.floors || 0, '#7cb2ff'],
    ['📦', 'Commits', m.commits || 0, '#a78bfa'],
    ['✅', 'Tests passed', pass, '#34d399'],
    ['❌', 'Tests failed', fail, '#f87171'],
    ['✔️', 'Tasks done', m.tasks_done || 0, '#fbbf24'],
  ];
  metricsEl.innerHTML = items.map(([ic, l, v, c]) =>
    '<div class="metric" style="--c:' + c + '"><span class="mi">' + ic + '</span><b>' + v + '</b><span class="ml">' + l + '</span></div>').join('') +
    '<div class="metric wide" style="--c:#34d399"><span class="ml">Test pass rate</span><b>' + (total ? Math.round((pass / total) * 100) + '%' : '—') +
    '</b><div class="bar"><i style="width:' + (total ? (pass / total) * 100 : 0) + '%"></i></div></div>';
}

const rosterEl = $('roster');
function updateRoster(agents) {
  if (!changed('roster', agents)) return;
  rosterEl.innerHTML = '';
  agents.forEach((a) => {
    const d = document.createElement('button');
    d.type = 'button'; d.className = 'rrow'; d.dataset.id = a.id;
    d.innerHTML = avatarHtml(a.name, ROLE_COLOR[a.role] || '#8792a3') +
      '<div class="rinfo"><div class="rname">' + escapeHtml(a.name) + '<small>' + escapeHtml(ROLE_LABEL[a.role] || a.role || '') + '</small></div>' +
      '<div class="rtask">' + escapeHtml(a.current_task || 'No active task') + '</div></div>' +
      '<span class="sbadge" style="--c:' + (STATUS_COLOR[a.status] || '#8792a3') + '">' + escapeHtml(a.status) + '</span>';
    d.addEventListener('click', () => followAgent(a.id));
    rosterEl.appendChild(d);
  });
}

/* ------------------------------------------------------------------ */
/* WebSocket                                                          */
/* ------------------------------------------------------------------ */
let sock = null, reconnectTimer = 0;
function connect() {
  clearTimeout(reconnectTimer);
  if (sock) { const old = sock; sock = null; old.close(); }   // its onclose sees ws !== sock and stays quiet
  const statusEl = $('status'), dot = $('dot');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = sock = new WebSocket(proto + '://' + location.host + '/ws?project=' + encodeURIComponent(currentProject));
  ws.onopen = () => { if (ws !== sock) return; statusEl.textContent = 'Live'; dot.classList.add('live'); };
  ws.onmessage = (ev) => {
    if (ws !== sock) return;                          // late message from a room we already left
    let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === 'snapshot') {
      // the server falls back to 'default' for unknown ids (e.g. a stale localStorage value) — follow it
      if (msg.project && msg.project !== currentProject) adoptProject(msg.project);
      ingest(msg.data);
    } else if (msg.type === 'projects') renderProjects(msg.data);
  };
  ws.onclose = () => {
    if (ws !== sock) return;                          // replaced by a project switch
    statusEl.textContent = 'Reconnecting…'; dot.classList.remove('live');
    reconnectTimer = setTimeout(connect, 1500);
  };
}

/* ------------------------------------------------------------------ */
/* Projects (rooms)                                                   */
/* ------------------------------------------------------------------ */
const projectSel = $('projectselect');
let projects = [];

function renderProjects(list) {
  if (Array.isArray(list)) projects = list;
  const shown = projects.some((p) => p.id === currentProject) ? projects : projects.concat([{ id: currentProject, name: currentProject }]);
  projectSel.innerHTML = '';
  shown.forEach((p) => {
    const o = document.createElement('option');
    o.value = p.id; o.textContent = p.name || p.id;
    projectSel.appendChild(o);
  });
  projectSel.value = currentProject;
}

function loadProjects() {
  return fetch('/api/projects').then((r) => (r.ok ? r.json() : null)).then((list) => { if (list) renderProjects(list); }).catch(() => {});
}

function adoptProject(pid) {
  currentProject = pid;
  store.set('office.project', pid);
  renderProjects();
}

function switchProject(pid) {
  if (!pid || pid === currentProject) return;
  adoptProject(pid);
  // forget the old room so its history isn't diffed against (or replayed into) the new one
  state = null; lastEventId = 0; firstSnapshot = true;
  for (const k in sigs) delete sigs[k];
  if (world) world.reset();
  updateSidebar({});
  $('status').textContent = 'Connecting…'; $('dot').classList.remove('live');
  connect();
}

projectSel.addEventListener('change', () => switchProject(projectSel.value));
$('newproject').addEventListener('click', () => {
  const name = (window.prompt('New project name (e.g. "CRM app")') || '').trim();
  if (!name) return;
  fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then((res) => { switchProject(res.id); loadProjects(); })
    .catch((err) => { console.error('create project failed', err); window.alert('Could not create the project.'); });
});

/* ------------------------------------------------------------------ */
/* Day / night                                                        */
/* ------------------------------------------------------------------ */
const dayBtn = $('daynight');
function renderDayBtn() {
  dayBtn.querySelector('.dn-ic').textContent = isDay ? '☀️' : '🌙';
  dayBtn.querySelector('.dn-lbl').textContent = isDay ? 'Day' : 'Night';
  dayBtn.title = isDay ? 'Switch to night' : 'Switch to day';
  dayBtn.setAttribute('aria-pressed', String(isDay));
}
dayBtn.addEventListener('click', () => {
  isDay = !isDay;
  store.set('office.daynight', isDay ? 'day' : 'night');
  renderDayBtn();
  if (world) world.setDay(isDay);
});

/* ------------------------------------------------------------------ */
/* Chat + tabs + chrome                                               */
/* ------------------------------------------------------------------ */
const chatInput = $('chatinput'), chatSend = $('chatsend');
function sendChat() {
  const text = chatInput.value.trim();
  if (!text || chatSend.disabled) return;
  chatSend.disabled = true;
  fetch('/api/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ speaker: 'user', message: text, project: currentProject }),
  }).then(() => { chatInput.value = ''; }).catch(() => {}).finally(() => { chatSend.disabled = false; chatInput.focus(); });
}
chatSend.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) sendChat(); });

document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((b) => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active'); btn.setAttribute('aria-selected', 'true');
    $(btn.dataset.panel).classList.add('active');
  });
});

$('resetview').addEventListener('click', () => { if (world) world.resetView(); });
$('asidetoggle').addEventListener('click', () => {
  document.body.classList.toggle('aside-closed');
  setTimeout(() => world && world.resize(), 30);
});

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */
try {
  world = initWorld();
} catch (err) {
  console.error('3D init failed', err);
  $('nogl').hidden = false;
  world = null;
}
renderDayBtn();
renderProjects();
loadProjects();
connect();

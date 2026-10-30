// Summits — main thread: UI, rendering, sensors.

import { skylineOf, grabFrame, align } from "./align.js";

const DEG = Math.PI / 180;
const $ = (s) => document.querySelector(s);
const canvas = $("#view");
const ctx = canvas.getContext("2d");
const video = $("#video");

const PRESETS = [
  { name: "Le Brévent, Chamonix", lat: 45.93391, lon: 6.83783 },
  { name: "Gornergrat, Zermatt", lat: 45.98331, lon: 7.78497 },
  { name: "Säntis", lat: 47.24937, lon: 9.34336 },
  { name: "Moucherotte, Grenoble", lat: 45.1476, lon: 5.63945 },
  { name: "Pic du Midi de Bigorre", lat: 42.93639, lon: 0.14167 },
  { name: "Mont Ventoux", lat: 44.17389, lon: 5.27861 },
];

const store = {
  get(k, d) { try { const v = localStorage.getItem("summits." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("summits." + k, JSON.stringify(v)); } catch {} },
};

const state = {
  loc: null, // { lat, lon, name }
  range: store.get("range", 150),
  eye: store.get("eye", 2),
  pano: null,
  peaks: [],
  view: { heading: 180, pitch: 2, ppd: 0 }, // ppd = CSS px per degree
  mode: "pano",
  cam: {
    heading: 0, pitch: 0, roll: 0, have: false,
    offH: store.get("offH", 0), offP: store.get("offP", 0), fov: store.get("fovScale", 1),
    basePpd: 10, iosOffset: null,
    auto: store.get("autoAlign", true), locked: false,
  },
  labels: [], // last drawn labels for hit testing (CSS px)
  dpr: 1,
  firstView: true,
};

// ---------- Horizon worker ----------
const worker = new Worker("horizon-worker.js");
let jobId = 0;
const pending = new Map();
worker.onmessage = (e) => {
  const m = e.data;
  const job = pending.get(m.id);
  if (!job) return;
  if (m.type === "progress") job.onProgress(m);
  else {
    pending.delete(m.id);
    m.type === "done" ? job.resolve(m) : job.reject(new Error(m.message));
  }
};
function computeHorizon(params, onProgress) {
  const id = ++jobId;
  for (const [k, j] of pending) { j.reject(new Error("superseded")); pending.delete(k); }
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, ...params });
  });
}

// ---------- Loading a viewpoint ----------
// Peaks come from a static OpenStreetMap snapshot split into 2°×2° cells.
let peakIndex = null;
const cellCache = new Map();
function loadCell(key) {
  if (!cellCache.has(key)) {
    cellCache.set(key, fetch(`peaks/${key}.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("cell " + r.status))))
      .catch((err) => { cellCache.delete(key); throw err; }));
  }
  return cellCache.get(key);
}
async function fetchPeaks(lat, lon, rKm) {
  if (!peakIndex) {
    peakIndex = fetch("peaks/index.json").then((r) => r.json()).then((j) => {
      $("#peaks-date").textContent = j.built;
      return { ...j, set: new Set(j.cells) };
    });
  }
  const idx = await peakIndex;
  const C = idx.cell;
  const dLat = (rKm / 111.2) + 0.05;
  const dLon = dLat / Math.max(0.05, Math.cos(lat * DEG));
  const keys = [];
  for (let a = Math.floor((lat - dLat) / C) * C; a <= lat + dLat; a += C) {
    for (let o = Math.floor((lon - dLon) / C) * C; o <= lon + dLon; o += C) {
      const ow = ((o + 180) % 360 + 360) % 360 - 180; // wrap the antimeridian
      const key = `${a}_${ow}`;
      if (idx.set.has(key)) keys.push(key);
    }
  }
  const lists = await Promise.all(keys.map(loadCell));
  return lists.flat();
}

let loadSeq = 0;
async function loadView(loc) {
  const seq = ++loadSeq;
  state.loc = loc;
  setPlace(loc.name || formatLatLon(loc.lat, loc.lon), "Computing the horizon…");
  const url = new URL(location.href);
  url.searchParams.set("lat", loc.lat.toFixed(5));
  url.searchParams.set("lon", loc.lon.toFixed(5));
  if (loc.name) url.searchParams.set("name", loc.name); else url.searchParams.delete("name");
  if (loc.snap) url.searchParams.set("snap", "1"); else url.searchParams.delete("snap");
  history.replaceState(null, "", url);

  showProgress(0, "Loading peaks and terrain…");
  let peaks = [];
  let peakError = null;
  const peaksP = fetchPeaks(loc.lat, loc.lon, state.range).catch((e) => { peakError = e; return []; });
  try {
    peaks = await peaksP;
    if (seq !== loadSeq) return;
    const res = await computeHorizon(
      { lat: loc.lat, lon: loc.lon, eye: state.eye, altitude: null, range: state.range, cols: 7200, peaks, snap: loc.snap ? 100 : 0 },
      (m) => {
        if (seq !== loadSeq) return;
        if (m.stage === "tiles") showProgress(0.75 * (m.done / m.total), `Terrain tiles ${m.done}/${m.total}`);
        else showProgress(0.75 + 0.25 * (m.done / m.total), "Tracing the horizon…");
      },
    );
    if (seq !== loadSeq) return;
    state.pano = prepPano(res);
    state.sky = skylineOf(res);
    state.cam.locked = false;
    state.peaks = res.peaks;
    hideProgress();
    const meta = `${Math.round(res.h0)} m · ${res.peaks.length} peaks in view · ${state.range} km`;
    setPlace(loc.name || formatLatLon(loc.lat, loc.lon), meta);
    if (peakError) toast("Peak names are unavailable right now. Ridges still show.");
    if (state.firstView && res.peaks.length) {
      state.view.heading = res.peaks[0].az; // face the highest visible summit
      state.view.pitch = Math.max(1, res.peaks[0].alt * 0.6);
    }
    state.firstView = false;
    console.info(`horizon: ${res.ms} ms ${JSON.stringify(res.timing)}, ${res.angles.length} entries, ${peaks.length} peaks fetched`);
    requestRender();
  } catch (err) {
    if (err.message === "superseded") return;
    hideProgress();
    console.error(err);
    toast("Could not compute this view. Try again.");
  }
}

// Precompute distance bins and color tables for the renderer.
function prepPano(res) {
  const maxD = state.range * 1000;
  const lnMax = Math.log(maxD / 15);
  const bins = new Uint8Array(res.dists.length);
  for (let i = 0; i < bins.length; i++) {
    bins[i] = Math.max(0, Math.min(250, Math.round((Math.log(res.dists[i] / 15) / lnMax) * 250)));
  }
  // A pixel is a ridge edge when the pixel above/beside it is much farther away.
  const edgeMin = new Uint8Array(256);
  for (let b = 0; b < 256; b++) {
    const d = 15 * Math.exp((b / 250) * lnMax);
    const far = Math.max(d * 1.25, d + 400);
    edgeMin[b] = Math.min(255, Math.ceil((Math.log(far / 15) / lnMax) * 250));
  }
  return { ...res, bins, edgeMin };
}

const rgba = (r, g, b, a = 255) => ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
const mix = (a, b, t) => a + (b - a) * t;
const TERR = new Uint32Array(256);
const EDGE = new Uint32Array(256);
const EDGE_CAM = new Uint32Array(256);
for (let b = 0; b < 256; b++) {
  const t = Math.pow(Math.min(1, b / 250), 1.6);
  const tr = mix(24, 112, t), tg = mix(29, 128, t), tb = mix(42, 166, t);
  TERR[b] = rgba(tr, tg, tb);
  const e = 0.92 - 0.55 * t; // edge strength fades with distance
  EDGE[b] = rgba(mix(tr, 246, e), mix(tg, 244, e), mix(tb, 236, e));
  EDGE_CAM[b] = rgba(255, 255, 255, Math.round(255 * (0.95 - 0.45 * t)));
}

// ---------- Rendering ----------
let off = null; // offscreen canvas for the terrain layer
let img = null, buf32 = null, idx = null;
let renderQueued = false;
function requestRender() {
  if (!renderQueued) { renderQueued = true; requestAnimationFrame(render); }
}

function resize() {
  state.dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth, h = window.innerHeight;
  canvas.width = Math.round(w * state.dpr);
  canvas.height = Math.round(h * state.dpr);
  if (!state.view.ppd) state.view.ppd = Math.max(w / 90, 4);
  clampView();
  updateCamFov();
  requestRender();
}

function clampView() {
  const w = window.innerWidth;
  state.view.ppd = Math.min(Math.max(state.view.ppd, w / 200), w / 6);
  state.view.pitch = Math.min(Math.max(state.view.pitch, -30), 45);
  state.view.heading = ((state.view.heading % 360) + 360) % 360;
}

function viewParams() {
  if (state.mode === "camera") {
    const c = state.cam;
    return { heading: c.heading + c.offH, pitch: c.pitch + c.offP, ppd: c.basePpd * c.fov, roll: c.roll };
  }
  return { ...state.view, roll: 0 };
}

function render() {
  renderQueued = false;
  const W = canvas.width, H = canvas.height, dpr = state.dpr;
  const camera = state.mode === "camera";
  const v = viewParams();
  const ppd = v.ppd * dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);

  // In camera mode the layer must cover the screen at any roll, so it is a square.
  const BW = camera ? Math.ceil(Math.hypot(W, H)) : W;
  const BH = camera ? BW : H;
  if (!off || off.width !== BW || off.height !== BH) {
    off = document.createElement("canvas");
    off.width = BW; off.height = BH;
    img = new ImageData(BW, BH);
    buf32 = new Uint32Array(img.data.buffer);
    idx = new Uint8Array(BW * BH);
  }

  if (state.pano) drawTerrain(BW, BH, v.heading, v.pitch, ppd, camera, dpr >= 1.5);
  else drawSkyOnly(BW, BH, v.pitch, ppd, camera);
  off.getContext("2d").putImageData(img, 0, 0);

  if (camera) {
    ctx.translate(W / 2, H / 2);
    ctx.rotate(v.roll * DEG);
    ctx.translate(-BW / 2, -BH / 2);
  }
  ctx.drawImage(off, 0, 0);
  const tx = camera ? (BW - W) / 2 : 0, ty = camera ? (BH - H) / 2 : 0;
  drawLabels(BW, BH, v, ppd, camera, tx, ty);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (!camera) drawCompass(W, H, v, ppd);
  if (camera) $("#cam-heading").textContent = `${Math.round(((v.heading % 360) + 360) % 360)}° ${compassName(v.heading)}`;
}

function skyRow(BH, pitch, ppd) {
  const rows = new Uint32Array(BH);
  for (let y = 0; y < BH; y++) {
    const elev = pitch + (BH / 2 - y) / ppd;
    const t = Math.min(1, Math.max(0, elev / 35));
    const s = Math.sqrt(t);
    rows[y] = rgba(mix(168, 12, s), mix(178, 18, s), mix(204, 40, s));
  }
  return rows;
}

function drawSkyOnly(BW, BH, pitch, ppd, camera) {
  if (camera) { buf32.fill(0); return; }
  const rows = skyRow(BH, pitch, ppd);
  for (let y = 0; y < BH; y++) buf32.fill(rows[y], y * BW, (y + 1) * BW);
}

function drawTerrain(BW, BH, heading, pitch, ppd, camera, thick) {
  const { offsets, angles, bins, edgeMin, cols } = state.pano;
  const colsPerDeg = cols / 360;
  const cy = BH / 2;
  idx.fill(255);
  for (let x = 0; x < BW; x++) {
    let az = (heading + (x - BW / 2) / ppd) % 360;
    if (az < 0) az += 360;
    const c = Math.round(az * colsPerDeg) % cols;
    let yPrev = BH;
    for (let k = offsets[c], end = offsets[c + 1]; k < end; k++) {
      const yTop = cy - (angles[k] - pitch) * ppd;
      if (yTop >= yPrev) continue;
      const y0 = Math.max(0, Math.ceil(yTop));
      const b = bins[k];
      for (let y = y0; y < yPrev; y++) idx[y * BW + x] = b;
      yPrev = y0;
      if (yPrev <= 0) break;
    }
  }
  const sky = camera ? null : skyRow(BH, pitch, ppd);
  const edgeLut = camera ? EDGE_CAM : EDGE;
  for (let y = 0; y < BH; y++) {
    const row = y * BW;
    const skyC = camera ? 0 : sky[y];
    for (let x = 0; x < BW; x++) {
      const p = row + x;
      const b = idx[p];
      if (b === 255) { buf32[p] = skyC; continue; }
      let m = y > 0 ? idx[p - BW] : 255;
      if (thick && y > 1) { const u2 = idx[p - 2 * BW]; if (u2 > m) m = u2; }
      if (x > 0 && idx[p - 1] > m) m = idx[p - 1];
      if (x < BW - 1 && idx[p + 1] > m) m = idx[p + 1];
      buf32[p] = m >= edgeMin[b] ? edgeLut[b] : camera ? 0 : TERR[b];
    }
  }
}

// "Mont Blanc / Monte Bianco" → "Mont Blanc" on the panorama; the card shows the full name.
function shortName(n) { const i = n.indexOf(" / "); return i > 0 ? n.slice(0, i) : n; }

function wrap180(a) { return ((a + 540) % 360) - 180; }

function drawLabels(BW, BH, v, ppd, camera, tx, ty) {
  const dpr = state.dpr;
  const spacing = 20 * dpr;
  const topY = 60 * dpr + ty;
  const baseY = topY + Math.min(240 * dpr, (BH - 2 * ty) * 0.34);
  const placed = [];
  for (const p of state.peaks) {
    const x = BW / 2 + wrap180(p.az - v.heading) * ppd;
    if (x < tx - 20 || x > BW - tx + 20) continue;
    const y = BH / 2 - (p.alt - v.pitch) * ppd;
    if (y < topY || y > BH - ty - 20 * dpr) continue;
    let clash = false;
    for (const q of placed) if (Math.abs(q.x - x) < spacing) { clash = true; break; }
    if (clash) continue;
    placed.push({ x, y, p });
    if (placed.length >= 80) break;
  }
  ctx.lineWidth = Math.max(1, dpr);
  ctx.textBaseline = "middle";
  state.labels = [];
  for (const { x, y, p } of placed) {
    const top = Math.min(baseY, y - 26 * dpr);
    const room = top - 4 * dpr - topY; // vertical space for the rotated text
    if (room < 40 * dpr) continue;
    ctx.strokeStyle = camera ? "rgba(255,255,255,.8)" : "rgba(232,236,245,.55)";
    ctx.lineWidth = Math.max(1, dpr);
    ctx.beginPath();
    ctx.moveTo(x, y - 4 * dpr);
    ctx.lineTo(x, top);
    ctx.stroke();
    ctx.fillStyle = "#ffb547";
    ctx.beginPath();
    ctx.arc(x, y, 2.5 * dpr, 0, Math.PI * 2);
    ctx.fill();
    const ele = p.ele ?? p.dem;
    const sub = ` ${ele} m`;
    const fontMain = `600 ${13 * dpr}px system-ui, -apple-system, sans-serif`;
    const fontSub = `${11 * dpr}px system-ui, -apple-system, sans-serif`;
    ctx.font = fontSub;
    const w2 = ctx.measureText(sub).width;
    ctx.font = fontMain;
    let label = shortName(p.name);
    let w1 = ctx.measureText(label).width;
    const showSub = w1 + w2 <= room || room - w2 > 70 * dpr;
    const maxMain = showSub ? room - w2 : room;
    if (w1 > maxMain) {
      while (label.length > 1 && ctx.measureText(label + "…").width > maxMain) label = label.slice(0, -1);
      label = label.trimEnd() + "…";
      w1 = ctx.measureText(label).width;
    }
    ctx.save();
    ctx.translate(x, top - 4 * dpr);
    ctx.rotate(-Math.PI / 2);
    ctx.lineJoin = "round";
    ctx.lineWidth = 3 * dpr;
    ctx.strokeStyle = "rgba(8,12,24,.85)";
    ctx.strokeText(label, 0, 0);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, 0, 0);
    if (showSub) {
      ctx.font = fontSub;
      ctx.strokeText(sub, w1, 0);
      ctx.fillStyle = "#c8d0e4";
      ctx.fillText(sub, w1, 0);
    }
    ctx.restore();
    // Hit box in CSS px (approximate in camera mode when rolled).
    state.labels.push({ x: (x - tx) / dpr, yTop: (topY - ty) / dpr, yBottom: (y - ty) / dpr, p });
  }
  ctx.lineWidth = 1;
}

const NAMES = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
function compassName(h) { return NAMES[Math.round((((h % 360) + 360) % 360) / 45) % 8]; }

function drawCompass(W, H, v, ppd) {
  const dpr = state.dpr;
  const bh = 30 * dpr;
  const y0 = H - bh;
  ctx.fillStyle = "rgba(11,16,32,.72)";
  ctx.fillRect(0, y0, W, bh + 100);
  const steps = [1, 2, 5, 10, 15, 30, 45, 90];
  const step = steps.find((s) => s * ppd >= 46 * dpr) || 90;
  const minor = step >= 10 ? step / 5 : step / 2;
  const left = v.heading - W / 2 / ppd, right = v.heading + W / 2 / ppd;
  ctx.strokeStyle = "rgba(232,236,245,.4)";
  ctx.lineWidth = dpr;
  ctx.beginPath();
  for (let a = Math.ceil(left / minor) * minor; a <= right; a += minor) {
    const x = W / 2 + (a - v.heading) * ppd;
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y0 + 5 * dpr);
  }
  ctx.stroke();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let a = Math.ceil(left / step) * step; a <= right; a += step) {
    const x = W / 2 + (a - v.heading) * ppd;
    const n = ((Math.round(a) % 360) + 360) % 360;
    const cardinal = n % 45 === 0;
    ctx.font = `${cardinal ? 700 : 400} ${12 * dpr}px system-ui, sans-serif`;
    ctx.fillStyle = n === 0 ? "#ffb547" : cardinal ? "#e8ecf5" : "#9aa6c2";
    ctx.fillText(cardinal ? NAMES[n / 45] : `${n}°`, x, y0 + bh / 2 + 2 * dpr);
  }
  ctx.textAlign = "left";
}

// ---------- Interaction ----------
const pointers = new Map();
let gesture = null;
canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
  gesture = pointers.size === 2 ? { dist: pinchDist() } : gesture;
});
canvas.addEventListener("pointermove", (e) => {
  const pt = pointers.get(e.pointerId);
  if (!pt) return;
  const dx = e.clientX - pt.x, dy = e.clientY - pt.y;
  pt.x = e.clientX; pt.y = e.clientY;
  if (pointers.size === 2 && gesture) {
    const d = pinchDist();
    zoomBy(d / gesture.dist);
    gesture.dist = d;
  } else if (pointers.size === 1) {
    const v = viewParams();
    if (state.mode === "camera") {
      // Rotate the drag into the rolled frame so it feels natural.
      const r = v.roll * DEG;
      const ux = dx * Math.cos(r) + dy * Math.sin(r);
      const uy = -dx * Math.sin(r) + dy * Math.cos(r);
      state.cam.offH -= ux / v.ppd;
      state.cam.offP += uy / v.ppd;
      if (state.cam.auto && Math.hypot(e.clientX - pt.x0, e.clientY - pt.y0) > 12) setAuto(false);
    } else {
      state.view.heading -= dx / v.ppd;
      state.view.pitch += dy / v.ppd;
      clampView();
    }
  }
  requestRender();
});
function endPointer(e) {
  const pt = pointers.get(e.pointerId);
  pointers.delete(e.pointerId);
  if (pointers.size < 2) gesture = null;
  if (pt && pointers.size === 0 && Math.hypot(e.clientX - pt.x0, e.clientY - pt.y0) < 6 && e.type === "pointerup") tap(e.clientX, e.clientY);
  if (state.mode === "camera") { store.set("offH", state.cam.offH); store.set("offP", state.cam.offP); store.set("fovScale", state.cam.fov); }
}
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener("wheel", (e) => { e.preventDefault(); zoomBy(Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
function pinchDist() { const [a, b] = [...pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; }
function zoomBy(f) {
  if (state.mode === "camera") state.cam.fov = Math.min(3, Math.max(0.33, state.cam.fov * f));
  else { state.view.ppd *= f; clampView(); }
  requestRender();
}
window.addEventListener("keydown", (e) => {
  if (e.target.closest("input, select") || state.mode === "camera") return;
  const v = state.view, k = e.key;
  if (k === "ArrowLeft") v.heading -= 5; else if (k === "ArrowRight") v.heading += 5;
  else if (k === "ArrowUp") v.pitch += 2; else if (k === "ArrowDown") v.pitch -= 2;
  else if (k === "+" || k === "=") v.ppd *= 1.2; else if (k === "-") v.ppd /= 1.2;
  else return;
  clampView(); requestRender();
});

function tap(x, y) {
  let best = null, bd = 22;
  for (const l of state.labels) {
    const dx = Math.abs(l.x - x);
    if (dx < bd && y >= l.yTop - 10 && y <= l.yBottom + 12) { best = l; bd = dx; }
  }
  if (best) showCard(best.p); else $("#card").hidden = true;
}

function showCard(p) {
  const card = $("#card");
  card.querySelector(".name").textContent = p.name;
  const ele = p.ele != null ? `${p.ele} m` : `≈${p.dem} m`;
  const dist = p.d < 10000 ? `${(p.d / 1000).toFixed(1)} km` : `${Math.round(p.d / 1000)} km`;
  card.querySelector(".facts").textContent = `${ele} · ${dist} away · bearing ${Math.round(p.az)}° ${compassName(p.az)}`;
  card.querySelector(".osm").href = `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=14/${p.lat}/${p.lon}`;
  card.hidden = false;
}
$("#card .close").onclick = () => { $("#card").hidden = true; };

// ---------- UI helpers ----------
function setPlace(name, meta) { $("#place-name").textContent = name; $("#place-meta").textContent = meta || ""; }
function formatLatLon(lat, lon) {
  return `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? "E" : "W"}`;
}
function showProgress(f, label) {
  const p = $("#progress");
  p.hidden = false;
  p.querySelector(".fill").style.width = `${Math.round(f * 100)}%`;
  p.querySelector(".label").textContent = label;
}
function hideProgress() { $("#progress").hidden = true; }
let toastTimer = 0;
function toast(msg, ms = 4000) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------- GPS ----------
$("#btn-gps").onclick = () => {
  if (!navigator.geolocation) return toast("This browser has no location access.");
  toast("Finding your position…", 15000);
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      $("#toast").hidden = true;
      state.firstView = state.mode !== "camera";
      loadView({ lat: pos.coords.latitude, lon: pos.coords.longitude, name: "My location" });
    },
    (err) => toast(`Location unavailable: ${err.message}`),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
  );
};

// ---------- Map sheet ----------
let map = null, marker = null, picked = null;
function openMap() {
  $("#map-sheet").hidden = false;
  if (!window.L) { toast("Map is still loading…"); return; }
  if (!map) {
    map = L.map("map", { zoomControl: true, attributionControl: true });
    L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      maxZoom: 17,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, <a href="https://opentopomap.org">OpenTopoMap</a>',
    }).addTo(map);
    map.on("click", (e) => pick(e.latlng.lat, e.latlng.lng, null));
    const box = $("#presets");
    for (const p of PRESETS) {
      const b = document.createElement("button");
      b.className = "chip";
      b.textContent = p.name;
      b.onclick = () => { pick(p.lat, p.lon, p.name, true); map.setView([p.lat, p.lon], 12); };
      box.append(b);
    }
  }
  const c = state.loc || PRESETS[0];
  setTimeout(() => {
    map.invalidateSize();
    map.setView([c.lat, c.lon], 11);
    pick(c.lat, c.lon, c.name, c.snap);
  }, 0);
}
function pick(lat, lon, name, snap = false) {
  picked = { lat, lon, name, snap };
  if (!marker) marker = L.circleMarker([lat, lon], { radius: 9, color: "#1a1205", weight: 2, fillColor: "#ffb547", fillOpacity: 1 }).addTo(map);
  marker.setLatLng([lat, lon]);
  $("#go").disabled = false;
  $("#go").textContent = name ? `View from ${name}` : "View from here";
}
$("#btn-map").onclick = openMap;
$("#place").onclick = openMap;
$("#go").onclick = () => {
  if (!picked) return;
  $("#map-sheet").hidden = true;
  state.firstView = true;
  loadView(picked);
};
for (const b of document.querySelectorAll("[data-close]")) b.onclick = () => { b.closest(".sheet").hidden = true; };

$("#search-form").onsubmit = async (e) => {
  e.preventDefault();
  const q = $("#search").value.trim();
  if (!q) return;
  const box = $("#search-results");
  box.hidden = false;
  box.textContent = "Searching…";
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&q=${encodeURIComponent(q)}`);
    const list = await res.json();
    box.textContent = "";
    if (!list.length) { box.textContent = "No results."; return; }
    for (const r of list) {
      const b = document.createElement("button");
      const name = r.name || r.display_name.split(",")[0];
      b.innerHTML = `<span></span><small></small>`;
      b.firstChild.textContent = name;
      b.lastChild.textContent = r.display_name;
      b.onclick = () => {
        box.hidden = true;
        const lat = +r.lat, lon = +r.lon;
        map.setView([lat, lon], 13);
        pick(lat, lon, name, true);
      };
      box.append(b);
    }
  } catch {
    box.textContent = "Search failed.";
  }
};

// ---------- Settings ----------
$("#btn-settings").onclick = () => { $("#settings-sheet").hidden = false; };
$("#opt-range").value = String(state.range);
$("#opt-eye").value = String(state.eye);
$("#opt-range").onchange = (e) => { state.range = +e.target.value; store.set("range", state.range); if (state.loc) loadView(state.loc); };
$("#opt-eye").onchange = (e) => { state.eye = +e.target.value; store.set("eye", state.eye); if (state.loc) loadView(state.loc); };

// ---------- Camera mode ----------
let stream = null;
$("#btn-cam").onclick = () => (state.mode === "camera" ? stopCamera() : startCamera());
$("#cam-reset").onclick = () => {
  state.cam.offH = 0; state.cam.offP = 0; state.cam.fov = 1;
  store.set("offH", 0); store.set("offP", 0); store.set("fovScale", 1);
  setAuto(true);
  requestRender();
};
$("#cam-auto").onclick = () => setAuto(!state.cam.auto);

// ---------- Auto-alignment ----------
// Every ~0.6 s, fit the computed skyline to the camera frame and nudge the
// heading, pitch and zoom corrections toward the fit. The first fit searches
// wide (compasses can be 20° off); once locked, it only tracks small drift.
let autoTimer = null;
function setAuto(on) {
  state.cam.auto = on;
  state.cam.locked = false;
  store.set("autoAlign", on);
  updateAutoUi();
}
function updateAutoUi() {
  const c = state.cam;
  $("#cam-auto").textContent = c.auto ? "Auto-align: on" : "Auto-align: off";
  $("#cam-auto").classList.toggle("on", c.auto);
  $(".hint").textContent = !c.auto
    ? "Drag to align the lines with the ridges. Pinch to fit the zoom."
    : c.locked ? "Locked on the skyline. Drag to adjust by hand." : "Point at the mountains to align on the skyline…";
}
function autoStep() {
  const c = state.cam;
  if (state.mode !== "camera" || !c.auto || !c.have || !state.sky || pointers.size) return;
  const frame = grabFrame(video);
  if (!frame) return;
  const sensor = { heading: c.heading, pitch: c.pitch, roll: c.roll, basePpd: c.basePpd };
  const view = { W: window.innerWidth, H: window.innerHeight };
  // Locked: track small drift. Not locked: search wide, and only accept a
  // fit that clearly beats every fit elsewhere.
  const r = c.locked
    ? align(frame, state.sky, sensor, c, view, { spanH: 3, spanP: 1.5, fixFov: true, minScore: 35 })
    : align(frame, state.sky, sensor, c, view, { spanH: 25, spanP: 5, minScore: 45, minMargin: 6 });
  if (!r) return;
  if (!r.ok) { c.misses = (c.misses || 0) + 1; if (c.misses > 5 && c.locked) { c.locked = false; updateAutoUi(); } return; }
  c.misses = 0;
  // Ease toward the fit; snap on the first lock.
  const k = c.locked ? 0.5 : 1;
  c.offH += wrap180(r.offH - c.offH) * k;
  c.offP += (r.offP - c.offP) * k;
  c.fov += (r.fov - c.fov) * k;
  if (!c.locked) { c.locked = true; updateAutoUi(); }
  store.set("offH", c.offH); store.set("offP", c.offP); store.set("fovScale", c.fov);
  requestRender();
}

async function startCamera() {
  try {
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== "granted") throw new Error("Motion sensor access was denied.");
    }
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser has no camera access.");
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  } catch (err) {
    toast(err.message || String(err));
    return;
  }
  video.srcObject = stream;
  video.hidden = false;
  await video.play().catch(() => {});
  state.mode = "camera";
  state.cam.have = false;
  state.cam.iosOffset = null;
  $("#btn-cam").classList.add("on");
  $("#cam-hud").hidden = false;
  $("#card").hidden = true;
  if ("ondeviceorientationabsolute" in window) window.addEventListener("deviceorientationabsolute", onOrient);
  else window.addEventListener("deviceorientation", onOrient);
  updateCamFov();
  state.cam.locked = false;
  updateAutoUi();
  clearInterval(autoTimer);
  autoTimer = setInterval(autoStep, 600);
  setTimeout(() => { if (!state.cam.have) toast("No compass data. Camera mode needs a phone with motion sensors.", 6000); }, 2500);
  requestRender();
}

function stopCamera() {
  clearInterval(autoTimer);
  window.removeEventListener("deviceorientationabsolute", onOrient);
  window.removeEventListener("deviceorientation", onOrient);
  if (stream) for (const t of stream.getTracks()) t.stop();
  stream = null;
  video.hidden = true;
  video.srcObject = null;
  // Keep looking where the phone was pointing.
  if (state.cam.have) {
    state.view.heading = state.cam.heading + state.cam.offH;
    state.view.pitch = state.cam.pitch + state.cam.offP;
    clampView();
  }
  state.mode = "pano";
  $("#btn-cam").classList.remove("on");
  $("#cam-hud").hidden = true;
  requestRender();
}

video.addEventListener("loadedmetadata", updateCamFov);
function updateCamFov() {
  const vw = video.videoWidth, vh = video.videoHeight;
  const W = window.innerWidth, H = window.innerHeight;
  if (!vw || !vh) { state.cam.basePpd = Math.max(W, H) / 75; return; }
  // Assume a typical phone main camera: ~75° across the long side of a 16:9
  // video frame (measured on an iPhone). Auto-align fits the rest.
  const f = Math.max(vw, vh) / 2 / Math.tan((75 / 2) * DEG);
  const s = Math.max(W / vw, H / vh); // object-fit: cover
  state.cam.basePpd = f * s * DEG;
}

// Device orientation → camera heading, pitch and roll (W3C Z-X'-Y'' angles).
function onOrient(e) {
  if (e.alpha == null || e.beta == null || e.gamma == null) return;
  const a = e.alpha * DEG, b = e.beta * DEG, g = e.gamma * DEG;
  const cA = Math.cos(a), sA = Math.sin(a), cB = Math.cos(b), sB = Math.sin(b), cG = Math.cos(g), sG = Math.sin(g);
  // Rotation matrix columns: device X, Y, Z axes in the Earth frame (x east, y north, z up).
  const X = [cA * cG - sA * sB * sG, sA * cG + cA * sB * sG, -cB * sG];
  const Y = [-cB * sA, cA * cB, sB];
  const Z = [cG * sA * sB + cA * sG, sA * sG - cA * cG * sB, cB * cG];
  const F = [-Z[0], -Z[1], -Z[2]]; // the back camera looks along -Z
  const th = ((screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0) * DEG;
  const right = [0, 1, 2].map((i) => Math.cos(th) * X[i] + Math.sin(th) * Y[i]);
  const up = [0, 1, 2].map((i) => -Math.sin(th) * X[i] + Math.cos(th) * Y[i]);
  let heading = Math.atan2(F[0], F[1]) / DEG;
  const pitch = Math.asin(Math.max(-1, Math.min(1, F[2]))) / DEG;
  const roll = Math.atan2(right[2], up[2]) / DEG;

  // iOS: alpha is relative; webkitCompassHeading gives true heading.
  if (e.webkitCompassHeading != null && !e.absolute) {
    const ref = Math.abs(e.beta) < 45 ? Math.atan2(Y[0], Y[1]) / DEG : heading;
    const off = wrap180(e.webkitCompassHeading - ref);
    const c = state.cam;
    c.iosOffset = c.iosOffset == null ? off : c.iosOffset + wrap180(off - c.iosOffset) * 0.1;
    heading += c.iosOffset;
  }

  const c = state.cam;
  if (!c.have) { c.heading = heading; c.pitch = pitch; c.roll = roll; c.have = true; }
  else {
    const k = 0.25; // low-pass to calm sensor jitter
    c.heading += wrap180(heading - c.heading) * k;
    c.pitch += (pitch - c.pitch) * k;
    c.roll += wrap180(roll - c.roll) * k;
  }
  requestRender();
}

// ---------- Boot ----------
window.addEventListener("resize", resize);
resize();
const qs = new URLSearchParams(location.search);
const qlat = parseFloat(qs.get("lat")), qlon = parseFloat(qs.get("lon"));
if (Number.isFinite(qlat) && Number.isFinite(qlon)) loadView({ lat: qlat, lon: qlon, name: qs.get("name") || null, snap: qs.get("snap") === "1" });
else loadView({ ...PRESETS[0], snap: true });

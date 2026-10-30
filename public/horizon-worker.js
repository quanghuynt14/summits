// Horizon engine. Loads elevation tiles, casts one ray per azimuth column,
// and returns the visible terrain surface plus the peaks that can be seen.
//
// Output per column: a list of entries (angle°, distance m), increasing in both.
// Entry k covers the screen band between entry k-1's angle and its own angle.

const R = 6371008.8; // mean Earth radius, m
const K = 0.13; // atmospheric refraction coefficient
const DEG = Math.PI / 180;
const TILE_URL = (z, x, y) => `/api/tiles/${z}/${x}/${y}.png`;
const MIN_ANGLE = -25; // ignore terrain below this view angle
const MERGE_DEG = 0.02; // merge contiguous surface steps smaller than this

const tileCache = new Map(); // "z/x/y" -> Promise<Float32Array|null>

function loadTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (tileCache.has(key)) {
    const p = tileCache.get(key);
    tileCache.delete(key); // refresh LRU order
    tileCache.set(key, p);
    return p;
  }
  const p = fetch(TILE_URL(z, x, y))
    .then((r) => (r.ok ? r.blob() : null))
    .then(async (blob) => {
      if (!blob) return null;
      const bmp = await createImageBitmap(blob, {
        colorSpaceConversion: "none",
        premultiplyAlpha: "none",
      });
      const c = new OffscreenCanvas(256, 256);
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, 256, 256).data;
      const e = new Float32Array(65536);
      for (let i = 0; i < 65536; i++) {
        e[i] = d[4 * i] * 256 + d[4 * i + 1] + d[4 * i + 2] / 256 - 32768;
      }
      return e;
    })
    .catch(() => null)
    .then((e) => {
      if (!e) tileCache.delete(key); // retry next time (e.g. back online)
      return e;
    });
  tileCache.set(key, p);
  while (tileCache.size > 500) tileCache.delete(tileCache.keys().next().value);
  return p;
}

const tileX = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const tileY = (lat, z) => {
  const s = Math.sin(lat * DEG);
  return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z);
};

const ZERO_TILE = new Float32Array(65536);

function pix(L, gx, gy) {
  const ix = (gx >> 8) - L.tx0;
  const iy = (gy >> 8) - L.ty0;
  if (ix < 0 || iy < 0 || ix >= L.nx || iy >= L.ny) return 0;
  return L.tiles[iy * L.nx + ix][((gy & 255) << 8) | (gx & 255)];
}

// Bilinear sample at normalized Web Mercator coords (0..1).
function sampleXY(L, mx, my) {
  const px = mx * L.size - 0.5;
  const py = my * L.size - 0.5;
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const fx = px - x0;
  const fy = py - y0;
  let a, b, c, d;
  const lx = x0 & 255, ly = y0 & 255;
  const ix = (x0 >> 8) - L.tx0, iy = (y0 >> 8) - L.ty0;
  if (lx !== 255 && ly !== 255 && ix >= 0 && iy >= 0 && ix < L.nx && iy < L.ny) {
    // Fast path: all four pixels in one tile.
    const t = L.tiles[iy * L.nx + ix];
    const i = (ly << 8) | lx;
    a = t[i]; b = t[i + 1]; c = t[i + 256]; d = t[i + 257];
  } else {
    a = pix(L, x0, y0);
    b = pix(L, x0 + 1, y0);
    c = pix(L, x0, y0 + 1);
    d = pix(L, x0 + 1, y0 + 1);
  }
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

const mercX = (lonDeg) => (lonDeg + 180) / 360;
const mercY = (latDeg) => {
  const s = Math.sin(latDeg * DEG);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
const sample = (L, latDeg, lonDeg) => sampleXY(L, mercX(lonDeg), mercY(latDeg));

async function prepareLevels(lat, lon, maxD, progress) {
  const levels = [
    { z: 13, maxD: Math.min(6000, maxD) },
    { z: 11, maxD: Math.min(40000, maxD) },
    { z: 9, maxD },
  ];
  const jobs = [];
  for (const L of levels) {
    const dLat = (L.maxD / R) / DEG;
    const dLon = dLat / Math.cos(lat * DEG);
    L.size = 256 * 2 ** L.z;
    L.tx0 = tileX(lon - dLon, L.z);
    L.tx1 = tileX(lon + dLon, L.z);
    L.ty0 = tileY(lat + dLat, L.z);
    L.ty1 = tileY(lat - dLat, L.z);
    L.nx = L.tx1 - L.tx0 + 1;
    L.ny = L.ty1 - L.ty0 + 1;
    L.tiles = new Array(L.nx * L.ny).fill(ZERO_TILE);
    for (let ty = L.ty0; ty <= L.ty1; ty++) {
      for (let tx = L.tx0; tx <= L.tx1; tx++) {
        jobs.push({ L, tx, ty });
      }
    }
  }
  let done = 0;
  let next = 0;
  let missing = 0;
  async function runner() {
    while (next < jobs.length) {
      const j = jobs[next++];
      const t = await loadTile(j.L.z, j.tx, j.ty);
      if (!t) missing++;
      j.L.tiles[(j.ty - j.L.ty0) * j.L.nx + (j.tx - j.L.tx0)] = t || ZERO_TILE;
      done++;
      if (done % 4 === 0 || done === jobs.length) progress("tiles", done, jobs.length);
    }
  }
  await Promise.all(Array.from({ length: 16 }, runner));
  levels.missing = missing;
  return levels;
}

async function run({ lat, lon, eye, altitude, range, cols, peaks, snap = 0 }, progress) {
  const maxD = range * 1000;
  const tA = performance.now();
  const levels = await prepareLevels(lat, lon, maxD, progress);
  const tB = performance.now();

  const sinLat0 = Math.sin(lat * DEG);
  const cosLat0 = Math.cos(lat * DEG);
  const tanLat0 = sinLat0 / cosLat0;

  // Optional snap: when the viewpoint is a named summit, stand on the highest
  // terrain within `snap` metres instead of a slightly-off map coordinate.
  if (snap > 0) {
    let best = sample(levels[0], lat, lon);
    let bLat = lat, bLon = lon;
    for (let n = -snap; n <= snap; n += 8) {
      for (let e = -snap; e <= snap; e += 8) {
        if (n * n + e * e > snap * snap) continue;
        const la = lat + n / R / DEG;
        const lo = lon + e / (R * cosLat0) / DEG;
        const h = sample(levels[0], la, lo);
        if (h > best) { best = h; bLat = la; bLon = lo; }
      }
    }
    lat = bLat;
    lon = bLon;
  }

  const ground = sample(levels[0], lat, lon);
  const h0 = altitude != null ? altitude : ground + eye;

  // Ray steps: 10 m near the observer, then 0.5% of the distance.
  const ds = [];
  for (let d = 15; d <= maxD; d += Math.max(10, d * 0.005)) ds.push(d);
  const n = ds.length;
  const lev = new Uint8Array(n);
  const drop = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d = ds[i];
    lev[i] = d <= levels[0].maxD ? 0 : d <= levels[1].maxD ? 1 : 2;
    drop[i] = ((d * d) / (2 * R)) * (1 - K);
  }

  // Lookup tables indexed by the northward offset u (metres along the meridian):
  // Mercator y and 1/cos(lat). Positions follow the great circle to second order:
  //   u = north - east² tan(lat0) / 2R,  lon = lon0 + east / (R cos(lat)).
  const TSTEP = 5;
  const U0 = maxD * 1.05 + 1000;
  const tn = Math.ceil((2 * U0) / TSTEP) + 2;
  const tY = new Float64Array(tn);
  const tSec = new Float64Array(tn);
  for (let j = 0; j < tn; j++) {
    const la = lat + (j * TSTEP - U0) / R / DEG;
    tY[j] = mercY(la);
    tSec[j] = 1 / Math.cos(la * DEG);
  }
  const mx0 = mercX(lon);
  const lonScale = 1 / (R * 2 * Math.PI); // metres east at the equator → Mercator x
  const halfTanR = tanLat0 / (2 * R);

  const offsets = new Uint32Array(cols + 1);
  let angles = new Float32Array(cols * 64);
  let dists = new Float32Array(cols * 64);
  let m = 0;

  // Columns are traced in blocks, distance-major inside a block, so that
  // neighbouring rays read the same tile memory together (cache friendly).
  const B = 32;
  const sinT = new Float64Array(B), cosT = new Float64Array(B);
  const maxS = new Float64Array(B), lastA = new Float64Array(B);
  const vis = new Uint8Array(B);
  const bufA = Array.from({ length: B }, () => []);
  const bufD = Array.from({ length: B }, () => []);

  for (let c0 = 0; c0 < cols; c0 += B) {
    const nb = Math.min(B, cols - c0);
    for (let k = 0; k < nb; k++) {
      const th = ((c0 + k) / cols) * 2 * Math.PI;
      sinT[k] = Math.sin(th);
      cosT[k] = Math.cos(th);
      maxS[k] = -Infinity;
      lastA[k] = -1e9;
      vis[k] = 0;
      bufA[k].length = 0;
      bufD[k].length = 0;
    }
    for (let i = 0; i < n; i++) {
      const d = ds[i];
      const L = levels[lev[i]];
      const dr = drop[i];
      for (let k = 0; k < nb; k++) {
        const e = d * sinT[k];
        const u = d * cosT[k] - e * e * halfTanR;
        const f = (u + U0) / TSTEP;
        const j = f | 0;
        const fr = f - j;
        const my = tY[j] + (tY[j + 1] - tY[j]) * fr;
        const sec = tSec[j] + (tSec[j + 1] - tSec[j]) * fr;
        const h = sampleXY(L, mx0 + e * sec * lonScale, my);
        const s = (h - dr - h0) / d;
        if (s > maxS[k]) {
          maxS[k] = s;
          const a = Math.atan(s) / DEG;
          if (a >= MIN_ANGLE) {
            const ba = bufA[k];
            if (vis[k] && ba.length && a - lastA[k] < MERGE_DEG) {
              ba[ba.length - 1] = a;
              bufD[k][ba.length - 1] = d;
            } else {
              ba.push(a);
              bufD[k].push(d);
              lastA[k] = a;
            }
          }
          vis[k] = 1;
        } else {
          vis[k] = 0;
        }
      }
    }
    for (let k = 0; k < nb; k++) {
      offsets[c0 + k] = m;
      const ba = bufA[k], bd = bufD[k];
      if (m + ba.length > angles.length) {
        const size = Math.max(angles.length * 2, m + ba.length);
        const na = new Float32Array(size); na.set(angles); angles = na;
        const nd = new Float32Array(size); nd.set(dists); dists = nd;
      }
      for (let q = 0; q < ba.length; q++) { angles[m] = ba[q]; dists[m] = bd[q]; m++; }
    }
    if ((c0 / B) % 8 === 7) progress("rays", c0 + nb, cols);
  }
  offsets[cols] = m;
  angles = angles.slice(0, m);
  dists = dists.slice(0, m);

  // Peak visibility: compare the peak's view angle with the highest terrain
  // in front of it along the nearest column.
  const visible = [];
  for (const [plat, plon, pele, name] of peaks) {
    const p1 = plat * DEG;
    const dl = (plon - lon) * DEG;
    const cosC = sinLat0 * Math.sin(p1) + cosLat0 * Math.cos(p1) * Math.cos(dl);
    const d = R * Math.acos(Math.min(1, Math.max(-1, cosC)));
    if (d < 150 || d > maxD) continue;
    const az =
      (Math.atan2(Math.sin(dl) * Math.cos(p1), cosLat0 * Math.sin(p1) - sinLat0 * Math.cos(p1) * Math.cos(dl)) / DEG + 360) % 360;
    const L = levels[d <= levels[0].maxD ? 0 : d <= levels[1].maxD ? 1 : 2];
    const dem = sample(L, plat, plon);
    const ele = pele != null ? Math.max(pele, dem) : dem;
    const alt = Math.atan((ele - ((d * d) / (2 * R)) * (1 - K) - h0) / d) / DEG;
    const c = Math.round((az / 360) * cols) % cols;
    const limit = d * 0.97 - 150;
    let block = -90;
    for (let k = offsets[c]; k < offsets[c + 1]; k++) {
      if (dists[k] >= limit) break;
      block = angles[k];
    }
    if (alt >= block - 0.15) {
      visible.push({ name, ele: pele, dem: Math.round(dem), lat: plat, lon: plon, d, az, alt });
    }
  }
  visible.sort((a, b) => (b.ele ?? b.dem) - (a.ele ?? a.dem));

  const timing = { tiles: Math.round(tB - tA), rays: Math.round(performance.now() - tB), steps: n };
  return { offsets, angles, dists, cols, h0, ground, lat, lon, peaks: visible, timing, missing: levels.missing };
}

self.onmessage = async (e) => {
  const { id } = e.data;
  const progress = (stage, done, total) => self.postMessage({ id, type: "progress", stage, done, total });
  try {
    const t0 = performance.now();
    const r = await run(e.data, progress);
    r.ms = Math.round(performance.now() - t0);
    self.postMessage({ id, type: "done", ...r }, [r.offsets.buffer, r.angles.buffer, r.dists.buffer]);
  } catch (err) {
    self.postMessage({ id, type: "error", message: String(err && err.stack ? err.stack : err) });
  }
};

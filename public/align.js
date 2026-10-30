// Auto-alignment for camera mode: fit the computed skyline to the camera image.
//
// Phone compasses drift by 5–15°, often more near buildings or metal. Instead
// of trusting the sensor, we look for the sky/terrain boundary in the frame and
// search the heading, pitch and zoom corrections that put the computed skyline
// on it. Only the far skyline is used: nearby slopes move too much with small
// GPS or terrain-model errors.

const DEG = Math.PI / 180;
const SMALL = 360; // long side of the analysis frame, in pixels

// Highest terrain angle per pano column, and its distance.
export function skylineOf(pano) {
  const { offsets, angles, dists, cols } = pano;
  const alt = new Float32Array(cols).fill(NaN);
  const dist = new Float32Array(cols);
  for (let c = 0; c < cols; c++) {
    const k = offsets[c + 1] - 1;
    if (k >= offsets[c]) { alt[c] = angles[k]; dist[c] = dists[k]; }
  }
  return { alt, dist, cols };
}

// Grab the current video frame as a blurred "sky-ness" image: 2·B − R. Sky is
// bright in blue whether clear, hazy or cloudy, and blue sky is bluer than
// anything on the ground. Rock, forest and grass score low, so a sunlit rock
// band above dark forest does not pass for a skyline.
let scratch = null;
export function grabFrame(video) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const k = SMALL / Math.max(vw, vh);
  const w = Math.round(vw * k), h = Math.round(vh * k);
  if (!scratch) scratch = document.createElement("canvas");
  if (scratch.width !== w || scratch.height !== h) { scratch.width = w; scratch.height = h; }
  const g = scratch.getContext("2d", { willReadFrequently: true });
  g.drawImage(video, 0, 0, w, h);
  return frameFromImageData(g.getImageData(0, 0, w, h), vw, vh);
}

export function frameFromImageData(im, vw, vh) {
  const { width: w, height: h, data } = im;
  const b = new Float32Array(w * h);
  for (let i = 0, p = 0; i < b.length; i++, p += 4) b[i] = 2 * data[p + 2] - data[p];
  // 3×3 box blur against sensor noise and texture.
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      out[i] = (b[i - w - 1] + b[i - w] + b[i - w + 1] + b[i - 1] + b[i] + b[i + 1] + b[i + w - 1] + b[i + w] + b[i + w + 1]) / 9;
    }
  }
  return { w, h, b: out, scale: w / vw, vw, vh };
}

// Score one pose: mean sky-ness contrast (above minus below) along the predicted
// skyline. High when the line sits on the sky/terrain boundary.
function score(frame, sky, samples, pose, view) {
  const { w, h, b } = frame;
  const { heading, pitch, ppd, roll } = pose;
  const cr = Math.cos(roll * DEG), sr = Math.sin(roll * DEG);
  const { W, H, s } = view; // screen size (CSS px) and screen px per video px
  const k = frame.scale / s; // analysis px per screen px
  const cx = frame.vw / 2 * frame.scale, cy = frame.vh / 2 * frame.scale;
  const step = 3; // analysis px between the two probes and the line
  const ux = sr * step, uy = -cr * step; // "up" on screen, in analysis px
  let sum = 0, n = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i];
    let az = (heading + a) % 360;
    if (az < 0) az += 360;
    const c = Math.round(az / 360 * sky.cols) % sky.cols;
    const alt = sky.alt[c];
    if (!(sky.dist[c] > 1500)) continue; // no far skyline here
    const u = a * ppd, v = -(alt - pitch) * ppd;
    const x = (u * cr - v * sr) * k + cx;
    const y = (u * sr + v * cr) * k + cy;
    const x0 = Math.round(x + ux), y0 = Math.round(y + uy);
    const x1 = Math.round(x - ux), y1 = Math.round(y - uy);
    if (x0 < 1 || x1 < 1 || y0 < 1 || y1 < 1 || x0 >= w - 1 || x1 >= w - 1 || y0 >= h - 1 || y1 >= h - 1) continue;
    const d = b[y0 * w + x0] - b[y1 * w + x1];
    sum += d > 80 ? 80 : d < -80 ? -80 : d;
    n++;
  }
  return n ? { s: sum / n, n } : { s: 0, n: 0 };
}

// Search heading, pitch and zoom corrections around the current ones.
// sensor: raw {heading, pitch, roll, basePpd}; cur: current {offH, offP, fov}.
// view: {W, H} screen size in CSS px. Returns null when nothing fits well.
export function align(frame, sky, sensor, cur, view, opts = {}) {
  const spanH = opts.spanH ?? 15, spanP = opts.spanP ?? 4;
  const s = Math.max(view.W / frame.vw, view.H / frame.vh); // object-fit: cover
  const v = { ...view, s };
  const halfW = Math.hypot(view.W, view.H) / 2;

  const evalPose = (offH, offP, fov, samples) => score(frame, sky, samples, {
    heading: sensor.heading + offH, pitch: sensor.pitch + offP,
    ppd: sensor.basePpd * fov, roll: sensor.roll,
  }, v);
  const samplesFor = (fov, stepDeg) => {
    const half = halfW / (sensor.basePpd * fov);
    const out = [];
    for (let a = -half; a <= half; a += stepDeg) out.push(a);
    return out;
  };

  // Coarse grid (1°, probes 1° apart), then refine the three best cells.
  // Zoom: phones differ by ±10% from the assumed field of view.
  const fs = opts.fovSpan ?? 0.1;
  const fovs = opts.fixFov ? [cur.fov] : [-1, -0.5, 0, 0.5, 1].map((t) => Math.min(2, Math.max(0.5, cur.fov * (1 + t * fs))));
  const coarse = [];
  const stepH = opts.fixFov ? 0.5 : 1, stepP = stepH;
  for (const fov of fovs) {
    const samples = samplesFor(fov, 1);
    for (let dh = -spanH; dh <= spanH; dh += stepH) {
      for (let dp = -spanP; dp <= spanP; dp += stepP) {
        const r = evalPose(cur.offH + dh, cur.offP + dp, fov, samples);
        if (r.n >= samples.length * 0.3) coarse.push({ s: r.s, n: r.n, offH: cur.offH + dh, offP: cur.offP + dp, fov });
      }
    }
  }
  if (!coarse.length) return null;
  coarse.sort((a, b) => b.s - a.s);
  // Ambiguity: how far ahead is the best coarse fit of the best one elsewhere?
  const rival = coarse.find((c) => Math.abs(c.offH - coarse[0].offH) > 3);
  const margin = rival ? coarse[0].s - rival.s : Infinity;

  let best = { s: -Infinity };
  for (const seed of coarse.slice(0, 3)) {
    // Rescore the seed with the fine samples so scores compare.
    const r0 = evalPose(seed.offH, seed.offP, seed.fov, samplesFor(seed.fov, 0.25));
    let cand = { ...seed, s: r0.s, n: r0.n };
    for (const [step, fstep] of [[0.5, 0.04], [0.2, 0.02], [0.08, 0.01]]) {
      const c0 = cand;
      for (const df of opts.fixFov ? [0] : [-fstep, 0, fstep]) {
        const fov = c0.fov * (1 + df);
        const samples = samplesFor(fov, 0.25);
        for (let dh = -step; dh <= step + 1e-9; dh += step) {
          for (let dp = -step; dp <= step + 1e-9; dp += step) {
            const r = evalPose(c0.offH + dh, c0.offP + dp, fov, samples);
            if (r.n >= samples.length * 0.3 && r.s > cand.s) cand = { s: r.s, n: r.n, offH: c0.offH + dh, offP: c0.offP + dp, fov };
          }
        }
      }
    }
    if (cand.s > best.s) best = cand;
  }

  // How much better than where the overlay is now? And is it a clear edge?
  const now = evalPose(cur.offH, cur.offP, cur.fov, samplesFor(cur.fov, 0.2));
  best.gain = best.s - now.s;
  best.margin = margin;
  best.ok = best.s >= (opts.minScore ?? 40) && margin >= (opts.minMargin ?? 0);
  return best;
}

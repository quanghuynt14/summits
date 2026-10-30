// Service worker: lets Summits run without a connection.
//
// - App files: network first (so updates show up), cache as fallback.
// - Terrain tiles and peak cells: cache first. Every tile the app fetches is
//   kept, and "Download this area" fills the same caches ahead of a trip.
// - Leaflet from cdnjs: cache first. Map tiles and search stay online-only.

const SHELL = "summits-shell-v1";
const TILES = "summits-tiles";
const PEAKS = "summits-peaks";
const LEAFLET = [
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js",
];
const APP = [
  "./", "app.js", "align.js", "horizon-worker.js", "style.css",
  "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png",
  "peaks/index.json",
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await c.addAll(APP);
    await Promise.all(LEAFLET.map((u) => c.add(new Request(u, { mode: "cors" })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL, TILES, PEAKS]);
    for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    if (url.pathname.startsWith("/api/tiles/")) return e.respondWith(cacheFirst(TILES, req));
    if (/^\/peaks\/-?\d+_-?\d+\.json$/.test(url.pathname)) return e.respondWith(cacheFirst(PEAKS, req));
    if (url.pathname.startsWith("/api/")) return;
    return e.respondWith(networkFirst(req));
  }
  if (url.hostname === "cdnjs.cloudflare.com") return e.respondWith(cacheFirst(SHELL, req));
});

async function cacheFirst(name, req) {
  const c = await caches.open(name);
  const hit = await c.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) c.put(req, res.clone()).catch(() => {});
  return res;
}

async function networkFirst(req) {
  const c = await caches.open(SHELL);
  // Page loads carry ?lat=…&lon=…; they all share one cached page.
  const key = req.mode === "navigate" ? "./" : req;
  try {
    const res = await fetch(req);
    if (res.ok) c.put(key, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const hit = await c.match(key);
    if (hit) return hit;
    throw err;
  }
}

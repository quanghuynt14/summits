// Serves the static app and proxies elevation tiles with long-lived caching.
// Peak names ship as static files (see scripts/build-peaks.mjs).

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/tiles/")) return tile(url);
    if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
    return env.ASSETS.fetch(request);
  },
};

// Elevation tiles (Terrarium PNG, AWS Open Data). The origin sends no cache
// headers and sits in us-east-1, so cache hard at the edge and in the browser.
async function tile(url) {
  const m = url.pathname.match(/^\/api\/tiles\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.png$/);
  if (!m) return json({ error: "bad tile path" }, 400);
  const [z, x, y] = m.slice(1).map(Number);
  if (z > 15 || x >= 2 ** z || y >= 2 ** z) return json({ error: "tile out of range" }, 400);
  const res = await fetch(`https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${z}/${x}/${y}.png`, {
    cf: { cacheEverything: true, cacheTtl: 30 * 24 * 3600 },
  });
  if (!res.ok) return new Response(null, { status: res.status === 404 ? 404 : 502 });
  return new Response(res.body, {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=31536000, immutable",
      "access-control-allow-origin": "*",
    },
  });
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

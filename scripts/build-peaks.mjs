// Builds the static peak dataset served from public/peaks/.
//
// Sources (either or both):
//   --geonames <file>  GeoNames dump rows (allCountries.txt format), already
//                      filtered to feature class T: PK, MT, VLC, HLL (not the range codes MTS, PKS).
//                      https://download.geonames.org/export/dump/ (CC BY 4.0)
//   --osm <file>       OpenStreetMap peaks as TSV: id, lat, lon, ele, name
//                      (Overpass: node["natural"~"^(peak|volcano)$"]["name"]; ODbL)
// OSM wins where both exist: a GeoNames point within 500 m of an OSM peak is dropped.
//
// Output: public/peaks/<lat>_<lon>.json, one file per 2°×2° cell (south-west
// corner), each an array of [lat, lon, ele|null, name]. Plus public/peaks/index.json.
//
//   node scripts/build-peaks.mjs --geonames t.tsv --osm alps.tsv

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const CELL = 2;
const DEDUP_M = 500;

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const geonamesFile = opt("--geonames");
const osmFile = opt("--osm");
if (!geonamesFile && !osmFile) {
  console.error("usage: node scripts/build-peaks.mjs [--geonames file] [--osm file]");
  process.exit(1);
}

const outDir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "public", "peaks");

function parseEle(v) {
  if (v == null || v === "") return null;
  const n = parseFloat(String(v).replace(",", ".").replace(/[^0-9.\-]/g, ""));
  if (!Number.isFinite(n) || n < -500 || n > 9000) return null;
  return Math.round(n);
}

async function* lines(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) if (line) yield line.split("\t");
}

const cells = new Map();
function add(lat, lon, ele, name) {
  const key = `${Math.floor(lat / CELL) * CELL}_${Math.floor(lon / CELL) * CELL}`;
  if (!cells.has(key)) cells.set(key, []);
  cells.get(key).push([Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5, ele, name]);
}

// Spatial hash of OSM points for de-duplication (0.01° bins ≈ 1.1 km).
const osmBins = new Set();
const bin = (lat, lon) => `${Math.floor(lat * 100)},${Math.floor(lon * 100)}`;
const osmPoints = new Map();

let nOsm = 0, nGeo = 0, nDup = 0;
if (osmFile) {
  for await (const [, latS, lonS, eleS, ...rest] of lines(osmFile)) {
    const name = rest.join(" ").trim();
    const lat = Number(latS), lon = Number(lonS);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    add(lat, lon, parseEle(eleS), name);
    const b = bin(lat, lon);
    osmBins.add(b);
    if (!osmPoints.has(b)) osmPoints.set(b, []);
    osmPoints.get(b).push([lat, lon]);
    nOsm++;
  }
}

function nearOsm(lat, lon) {
  const by = Math.floor(lat * 100), bx = Math.floor(lon * 100);
  const kx = Math.cos(lat * Math.PI / 180);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const pts = osmPoints.get(`${by + dy},${bx + dx}`);
      if (!pts) continue;
      for (const [a, o] of pts) {
        const m = Math.hypot((a - lat) * 111195, (o - lon) * 111195 * kx);
        if (m < DEDUP_M) return true;
      }
    }
  }
  return false;
}

if (geonamesFile) {
  // allCountries columns: 1 name, 4 lat, 5 lon, 6 class, 7 code, 15 elevation, 16 dem
  for await (const f of lines(geonamesFile)) {
    const name = f[1]?.trim();
    const lat = Number(f[4]), lon = Number(f[5]);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (osmPoints.size && nearOsm(lat, lon)) { nDup++; continue; }
    let ele = parseEle(f[15]);
    if (ele == null) {
      const dem = parseEle(f[16]);
      if (dem != null && dem > -9000) ele = dem;
    }
    add(lat, lon, ele, name);
    nGeo++;
  }
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
let bytes = 0, biggest = 0;
for (const [key, list] of cells) {
  const json = JSON.stringify(list);
  bytes += json.length;
  biggest = Math.max(biggest, json.length);
  fs.writeFileSync(path.join(outDir, `${key}.json`), json);
}
fs.writeFileSync(
  path.join(outDir, "index.json"),
  JSON.stringify({ cell: CELL, built: new Date().toISOString().slice(0, 10), cells: [...cells.keys()].sort() }),
);
console.log(
  `${nOsm} OSM + ${nGeo} GeoNames peaks (${nDup} duplicates dropped) in ${cells.size} cells, ` +
    `${(bytes / 1e6).toFixed(1)} MB total, largest cell ${(biggest / 1e6).toFixed(2)} MB`,
);

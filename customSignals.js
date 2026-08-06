"use strict";

// customSignals.js — the ingested traffic-light dataset, in memory.
//
// ---------------------------------------------------------------------------
// WHY THIS IS SEPARATE FROM THE OVERPASS PATH
//
// The existing signals path fetches OSM nodes along the ACTIVE ROUTE CORRIDOR,
// on demand, and returns a few dozen. This one holds a whole city or country up
// front and answers "what is in this viewport". Different lifetime, different
// query, different failure mode — sharing code between them would mean one
// cache policy serving two jobs badly.
//
// They are also complementary rather than competing. Municipal data is
// authoritative where it exists and silent everywhere else; OSM is patchy but
// global. Serving the union, deduplicated, beats either alone — which is not a
// compromise on data quality, it is more lights than the custom set contains.
// ---------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");

/** ~1.1km at the equator. Small enough to keep buckets short in a dense city. */
const CELL_DEG = 0.01;

function cellKey(lon, lat) {
  return `${Math.floor(lon / CELL_DEG)}:${Math.floor(lat / CELL_DEG)}`;
}

/**
 * Load and index. Returns a queryable set, or an empty one when there is no
 * dataset — which is the normal state until someone runs the ingester.
 */
function loadCustomSignals(file) {
  const empty = {
    count: 0,
    source: null,
    ingestedAt: null,
    all: () => [],
    inBbox: () => [],
    near: () => [],
  };

  if (!fs.existsSync(file)) {
    console.log(`[signals] no custom dataset at ${file} — OSM only`);
    return empty;
  }

  let fc;
  try {
    fc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.warn(`[signals] ${file} is not valid JSON: ${err.message} — OSM only`);
    return empty;
  }

  const feats = Array.isArray(fc?.features) ? fc.features : [];
  const points = [];
  // Grid index. A quadtree would be tidier, but a flat hash over ~1km cells
  // answers a viewport query in one pass over a handful of buckets and needs no
  // dependency — and the whole dataset is a few thousand points, not millions.
  const grid = new Map();

  for (const f of feats) {
    const c = f?.geometry?.coordinates;
    if (f?.geometry?.type !== "Point" || !Array.isArray(c)) continue;
    const [lon, lat] = c;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const p = {
      id: String(f.properties?.id ?? `sig-${points.length}`),
      lon,
      lat,
      name: f.properties?.name ?? null,
      // Marks these as surveyed, not inferred. The client dims inferred lights;
      // these must never be dimmed, because they are the authoritative ones.
      inferred: false,
      custom: true,
    };
    points.push(p);
    const k = cellKey(lon, lat);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(p);
  }

  console.log(
    `[signals] ${points.length} custom signal(s) from ${path.basename(file)}` +
      (fc.metadata?.source ? ` (source: ${fc.metadata.source})` : "")
  );

  return {
    count: points.length,
    source: fc.metadata?.source ?? null,
    ingestedAt: fc.metadata?.ingestedAt ?? null,
    all: () => points,

    /** Everything inside a viewport, capped so a zoomed-out request can't flood. */
    inBbox(minLon, minLat, maxLon, maxLat, limit = 3000) {
      const out = [];
      const x0 = Math.floor(minLon / CELL_DEG);
      const x1 = Math.floor(maxLon / CELL_DEG);
      const y0 = Math.floor(minLat / CELL_DEG);
      const y1 = Math.floor(maxLat / CELL_DEG);
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const bucket = grid.get(`${x}:${y}`);
          if (!bucket) continue;
          for (const p of bucket) {
            if (p.lon < minLon || p.lon > maxLon || p.lat < minLat || p.lat > maxLat) continue;
            out.push(p);
            if (out.length >= limit) return out;
          }
        }
      }
      return out;
    },

    /** Signals within radiusM of a point — used to merge against OSM results. */
    near(lon, lat, radiusM) {
      const dLat = radiusM / 111320;
      const dLon = dLat / Math.max(0.1, Math.cos((lat * Math.PI) / 180));
      return this.inBbox(lon - dLon, lat - dLat, lon + dLon, lat + dLat, 500);
    },
  };
}

/**
 * Union of custom and OSM signals, custom winning on collision.
 *
 * `dedupeM` is 35m rather than something tighter because the two sources
 * disagree about what a signal IS: OSM tags one node per stop line, so a
 * crossroads is four nodes, while a municipal export is often one row per
 * junction. Matching loosely means the authoritative point replaces the OSM
 * cluster rather than sitting on top of it.
 */
function mergeSignals(customList, osmList, dedupeM = 35) {
  const out = customList.slice();
  const dLat = dedupeM / 111320;
  for (const o of osmList) {
    const clash = out.some((c) => {
      const dy = Math.abs(c.lat - o.lat);
      if (dy > dLat) return false;
      const dx =
        Math.abs(c.lon - o.lon) * Math.cos((o.lat * Math.PI) / 180);
      return Math.hypot(dx * 111320, dy * 111320) <= dedupeM;
    });
    if (!clash) out.push(o);
  }
  return out;
}

module.exports = { loadCustomSignals, mergeSignals, CELL_DEG };

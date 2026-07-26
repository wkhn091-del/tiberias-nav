// lib/laneGeometry.ts
//
// Synthesised lane-level road geometry.
//
// WHY THIS EXISTS
// High-end Chinese navigation apps (Amap, Baidu) don't draw a route as one flat
// ribbon — they draw a CARRIAGEWAY: asphalt with edge lines, dashed lane
// dividers, and markings painted flat onto the surface. That reads as a road
// you're driving on rather than a line drawn over a map, and it's most of the
// difference in feel.
//
// OSM has no lane geometry, and the `lanes` tag is just a count with no
// centrelines. But we already own the route polyline, so the carriageway can be
// DERIVED from it: offset the centreline laterally by a lane width and you get
// the divider; offset by half the road width and you get the edge. Everything
// here is that idea plus the plumbing to keep it cheap.
//
// All offsets are computed in a local metre-space projection and converted back
// to lon/lat, so they scale correctly with zoom for free — unlike MapLibre's
// pixel-based line widths, which don't correspond to real-world width.

export type LngLat = [number, number];

const M_PER_DEG_LAT = 111320;

/** Local equirectangular projection around a reference latitude. */
function projector(refLat: number) {
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((refLat * Math.PI) / 180);
  return {
    toXY: ([lon, lat]: LngLat): [number, number] => [lon * mPerDegLon, lat * M_PER_DEG_LAT],
    toLngLat: ([x, y]: [number, number]): LngLat => [x / mPerDegLon, y / M_PER_DEG_LAT],
  };
}

/**
 * Offset a polyline sideways by `metres` (positive = left of travel).
 *
 * Uses the averaged normal of the two segments meeting at each vertex, which
 * keeps corners continuous instead of tearing them apart. This is deliberately
 * NOT a true mitre offset: a real one needs join resolution and self-
 * intersection cleanup, and at lane widths of 3-4m over road-scale curvature
 * the difference is invisible while the cost and failure modes are not.
 */
export function offsetPolyline(coords: LngLat[], metres: number): LngLat[] {
  if (!Array.isArray(coords) || coords.length < 2) return [];
  const { toXY, toLngLat } = projector(coords[0][1]);
  const pts = coords.map(toXY);
  const out: LngLat[] = [];

  for (let i = 0; i < pts.length; i++) {
    // unit normals of the incoming and outgoing segments
    const normals: [number, number][] = [];
    if (i > 0) normals.push(segmentNormal(pts[i - 1], pts[i]));
    if (i < pts.length - 1) normals.push(segmentNormal(pts[i], pts[i + 1]));
    if (normals.length === 0) continue;

    let nx = 0;
    let ny = 0;
    for (const [a, b] of normals) {
      nx += a;
      ny += b;
    }
    const len = Math.hypot(nx, ny);
    if (len < 1e-9) continue; // doubled-back vertex; skip rather than divide by ~0
    nx /= len;
    ny /= len;

    out.push(toLngLat([pts[i][0] + nx * metres, pts[i][1] + ny * metres]));
  }
  return out;
}

/** Left-hand unit normal of a segment in metre space. */
function segmentNormal(a: [number, number], b: [number, number]): [number, number] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return [0, 0];
  return [-dy / len, dx / len];
}

/** Planar distance in metres between two lon/lat points (fine at road scale). */
function metresBetween(a: LngLat, b: LngLat): number {
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((a[1] * Math.PI) / 180);
  const dx = (b[0] - a[0]) * mPerDegLon;
  const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

/**
 * The next `aheadM` metres of route, starting from the vertex nearest the
 * driver.
 *
 * Bounding the geometry is what keeps this affordable: lane lines are only
 * legible within a few hundred metres at navigation zoom, so synthesising them
 * for a 40km route would be thousands of wasted vertices recomputed on every
 * fix.
 */
export function routeAhead(
  coords: LngLat[],
  fromLat: number,
  fromLon: number,
  aheadM: number
): LngLat[] {
  if (!Array.isArray(coords) || coords.length < 2) return [];
  let startIdx = 0;
  let best = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = metresBetween([fromLon, fromLat], coords[i]);
    if (d < best) {
      best = d;
      startIdx = i;
    }
  }
  const out: LngLat[] = [coords[startIdx]];
  let remaining = aheadM;
  for (let i = startIdx; i < coords.length - 1 && remaining > 0; i++) {
    const seg = metresBetween(coords[i], coords[i + 1]);
    if (seg <= 0) continue;
    if (remaining <= seg) {
      const f = remaining / seg;
      out.push([
        coords[i][0] + (coords[i + 1][0] - coords[i][0]) * f,
        coords[i][1] + (coords[i + 1][1] - coords[i][1]) * f,
      ]);
      break;
    }
    out.push(coords[i + 1]);
    remaining -= seg;
  }
  return out.length >= 2 ? out : [];
}

export type LaneGeometry = {
  /** Centreline of the visible stretch — the asphalt band is drawn on this. */
  centre: LngLat[];
  /** Dashed interior lane dividers. */
  dividers: LngLat[][];
  /** Solid outer edge lines. */
  edges: LngLat[][];
};

/** A lane count sampled at a point on the route, as resolved from OSM. */
export type LaneSample = {
  lat: number;
  lon: number;
  /** null = no OSM way matched here; the road width is genuinely unknown. */
  lanes: number | null;
  /**
   * Phase 51. True when the way carries traffic in one direction only.
   *
   * This decides WHERE the forward lanes sit. `lanes` from the server is
   * already a per-direction count, but a count alone doesn't say which half of
   * the road it occupies: on a oneway way the OSM geometry is the carriageway
   * centre, while on a two-way way it is the ROAD centre and our direction owns
   * only the right-hand half. Defaults to false (two-way) when absent, which is
   * both the common case and the safer error.
   */
  oneway?: boolean;
  /**
   * Phase 44. Legal limit in km/h, or null when OSM doesn't say. The server
   * refuses to infer this from road class (see parseMaxspeedKmh), so null here
   * means genuinely unknown rather than "probably urban".
   */
  maxspeedKmh?: number | null;
};

/** A run of route with a single, constant lane count. */
export type LaneSpan = { coords: LngLat[]; lanes: number; known: boolean; oneway: boolean };

/**
 * Signed lateral offset, in metres, from a way's centreline to the centre of
 * the carriageway WE are driving on. Positive is LEFT of travel, matching
 * offsetPolyline.
 *
 * PHASE 51 — the "corridor in oncoming traffic" bug.
 *
 * Every lane builder here centres its output on the line it is handed. That is
 * correct only when that line is the carriageway centre. For a oneway way it
 * is. For an ordinary two-way street the OSM geometry runs down the middle of
 * the ROAD, so centring the forward lanes on it lays half of them across the
 * centre line — and because a left turn selects the LEFTMOST forward lane, the
 * highlighted corridor landed squarely in oncoming traffic.
 *
 * Israel drives on the right, so our carriageway is the right-hand half and the
 * shift is negative. Expressed through RIGHT_HAND_TRAFFIC rather than a bare
 * minus sign so the assumption is visible and invertible.
 *
 * Shifting the CENTRELINE once, here, keeps the asphalt, the arrows and the
 * corridor in agreement by construction: they all consume the shifted line.
 */
export const RIGHT_HAND_TRAFFIC = true;

export function carriagewayOffsetM(
  lanes: number,
  oneway: boolean,
  laneWidthM: number
): number {
  if (oneway) return 0;
  const n = Math.max(1, Math.min(6, Math.floor(lanes)));
  const half = (n * laneWidthM) / 2;
  return RIGHT_HAND_TRAFFIC ? -half : half;
}

/**
 * Lane count nearest to a point, from the sampled data.
 *
 * Returns null when nothing is close enough OR the nearest sample is itself
 * unknown — the caller must be able to distinguish "one lane" from "we don't
 * know", because drawing dividers we can't justify is the failure mode this
 * whole module exists to avoid.
 */
/**
 * The sampled way nearest to a point, or null when none is within maxDistM.
 *
 * Phase 51: factored out of lanesAt so the lane COUNT and the oneway FLAG are
 * always read from the same sample. Resolving them independently would let a
 * span combine one way's lane count with a neighbouring way's direction, which
 * is precisely the sort of mismatch that puts a corridor on the wrong side.
 */
export function nearestSample(
  samples: LaneSample[],
  lon: number,
  lat: number,
  maxDistM = 200
): LaneSample | null {
  let best: LaneSample | null = null;
  let bestD = Infinity;
  for (const s of samples) {
    const d = metresBetween([lon, lat], [s.lon, s.lat]);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best && bestD <= maxDistM ? best : null;
}

export function lanesAt(
  samples: LaneSample[],
  lon: number,
  lat: number,
  maxDistM = 200
): number | null {
  return nearestSample(samples, lon, lat, maxDistM)?.lanes ?? null;
}

/**
 * Legal speed limit at a position, in km/h, or null when unknown.
 *
 * Sibling of lanesAt above and deliberately identical in shape — same nearest
 * sample, same distance ceiling — so the two can never disagree about which
 * stretch of road the driver is on.
 *
 * ACCURACY CEILING worth knowing about: samples are probed every
 * SIGNALS_SAMPLE_M (250m) along the route, so the driver is at most ~125m from
 * the nearest one. Where a limit changes mid-block, this value lags the sign on
 * the pole by up to that distance. It is a good enough basis for an advisory
 * HUD; it is not a substitute for reading the road.
 *
 * A tighter default ceiling than lanesAt's 200m: an out-of-date lane count only
 * skews geometry, whereas a limit borrowed from a road 200m away could be a
 * different road entirely.
 */
export function speedLimitAt(
  samples: LaneSample[],
  lon: number,
  lat: number,
  maxDistM = 130
): number | null {
  let best: LaneSample | null = null;
  let bestD = Infinity;
  for (const s of samples) {
    if (s.maxspeedKmh == null) continue; // an unmapped sample must not win
    const d = metresBetween([lon, lat], [s.lon, s.lat]);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  if (!best || bestD > maxDistM) return null;
  return best.maxspeedKmh ?? null;
}

/**
 * Split a centreline into runs of constant lane count.
 *
 * Lane counts change at junctions and slip roads, so a single road width for
 * the whole visible stretch would be wrong the moment the road widens. Each run
 * becomes its own feature and gets its own offsets, so the carriageway
 * physically narrows and widens with the real road.
 *
 * Runs overlap by one vertex so there's no visual gap at the seam.
 */
export function splitByLanes(
  centreline: LngLat[],
  samples: LaneSample[],
  fallback: number | null = null
): LaneSpan[] {
  if (!Array.isArray(centreline) || centreline.length < 2) return [];

  const resolve = (p: LngLat): { lanes: number; known: boolean; oneway: boolean } => {
    // Phase 51: the oneway flag comes from the SAME nearest sample as the lane
    // count, so a span can never mix one way's count with another's direction.
    const near = samples.length ? nearestSample(samples, p[0], p[1]) : null;
    const oneway = !!near?.oneway;
    const n = samples.length ? lanesAt(samples, p[0], p[1]) : null;
    if (n && n > 0) return { lanes: Math.min(6, n), known: true, oneway };
    if (fallback && fallback > 0) return { lanes: fallback, known: false, oneway };
    // Unknown: render as a single carriageway with no interior dividers, which
    // claims nothing about capacity.
    return { lanes: 1, known: false, oneway };
  };

  const spans: LaneSpan[] = [];
  let current = resolve(centreline[0]);
  let run: LngLat[] = [centreline[0]];

  for (let i = 1; i < centreline.length; i++) {
    const here = resolve(centreline[i]);
    if (
      here.lanes !== current.lanes ||
      here.known !== current.known ||
      here.oneway !== current.oneway
    ) {
      run.push(centreline[i]); // overlap the seam
      if (run.length >= 2) spans.push({ coords: run, ...current });
      run = [centreline[i]];
      current = here;
    } else {
      run.push(centreline[i]);
    }
  }
  if (run.length >= 2) spans.push({ coords: run, ...current });
  return spans;
}

/**
 * Build a carriageway for one span.
 *
 * Interior dividers only exist between adjacent lanes, so a single-lane span
 * produces edge lines and NO dashed centre line — which is exactly right for a
 * residential street, and was the specific inaccuracy in the fixed-2-lane
 * version.
 */
export function buildLanes(
  centreline: LngLat[],
  lanes = 1,
  laneWidthM = 3.5
): LaneGeometry {
  if (!Array.isArray(centreline) || centreline.length < 2) {
    return { centre: [], dividers: [], edges: [] };
  }
  const n = Math.max(1, Math.min(6, Math.floor(lanes)));
  const halfWidth = (n * laneWidthM) / 2;

  const dividers: LngLat[][] = [];
  // i runs 1..n-1, so n === 1 yields none at all.
  for (let i = 1; i < n; i++) {
    const offset = -halfWidth + i * laneWidthM;
    const line = offsetPolyline(centreline, offset);
    if (line.length >= 2) dividers.push(line);
  }

  const edges: LngLat[][] = [];
  for (const offset of [halfWidth, -halfWidth]) {
    const line = offsetPolyline(centreline, offset);
    if (line.length >= 2) edges.push(line);
  }

  return { centre: centreline, dividers, edges };
}

/**
 * Full carriageway across every span, as three FeatureCollections ready for
 * MapLibre. Each asphalt feature carries its own `laneCount`, so the layer can
 * scale line width per-feature and the road visibly widens and narrows.
 */
export function buildCarriageway(spans: LaneSpan[], laneWidthM = 3.5) {
  const asphalt: any[] = [];
  const dividers: any[] = [];
  const edges: any[] = [];

  spans.forEach((span, si) => {
    // Phase 51: move onto OUR carriageway before building anything. A two-way
    // way's geometry is the road centre, not ours.
    const off = carriagewayOffsetM(span.lanes, span.oneway, laneWidthM);
    const centre = off === 0 ? span.coords : offsetPolyline(span.coords, off);
    const g = buildLanes(centre.length >= 2 ? centre : span.coords, span.lanes, laneWidthM);
    if (g.centre.length >= 2) {
      asphalt.push({
        type: "Feature",
        id: `asphalt-${si}`,
        properties: { laneCount: span.lanes, known: span.known ? 1 : 0 },
        geometry: { type: "LineString", coordinates: g.centre },
      });
    }
    g.dividers.forEach((coordinates, i) =>
      dividers.push({
        type: "Feature",
        id: `divider-${si}-${i}`,
        // `known` rides along so the layer can dim a divider we INFERRED from
        // the fallback lane count rather than read from OSM. Same honesty
        // contract as inferred signals and inferred lane assist: draw it, but
        // don't present a guess at the same strength as surveyed data.
        properties: { known: span.known ? 1 : 0 },
        geometry: { type: "LineString", coordinates },
      })
    );
    g.edges.forEach((coordinates, i) =>
      edges.push({
        type: "Feature",
        id: `edge-${si}-${i}`,
        properties: { known: span.known ? 1 : 0 },
        geometry: { type: "LineString", coordinates },
      })
    );
  });

  return {
    asphalt: { type: "FeatureCollection" as const, features: asphalt },
    dividers: { type: "FeatureCollection" as const, features: dividers },
    edges: { type: "FeatureCollection" as const, features: edges },
  };
}

/**
 * Regular polygon around a point, as a GeoJSON Polygon ring.
 *
 * Feeds `fill-extrusion`, which is the only way to make something genuinely
 * STAND UP on the map — a symbol always faces the camera or lies flat, but an
 * extruded polygon has real height in the scene and is occluded by buildings
 * correctly. This is how the maneuver beacons get their 3D presence.
 */
export function circlePolygon(
  lon: number,
  lat: number,
  radiusM: number,
  sides = 24
): { type: "Polygon"; coordinates: LngLat[][] } {
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
  const ring: LngLat[] = [];
  for (let i = 0; i <= sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    ring.push([
      lon + (Math.cos(a) * radiusM) / mPerDegLon,
      lat + (Math.sin(a) * radiusM) / M_PER_DEG_LAT,
    ]);
  }
  return { type: "Polygon", coordinates: [ring] };
}

/**
 * A rectangular slab lying across the road at a point — used for the "gate"
 * markers that Chinese apps stand up at an upcoming turn.
 *
 * `bearingDeg` is the road's direction of travel; the slab is built
 * perpendicular to it so it spans the carriageway like a gantry.
 */
export function crossbarPolygon(
  lon: number,
  lat: number,
  bearingDeg: number,
  widthM: number,
  thicknessM = 2.5
): { type: "Polygon"; coordinates: LngLat[][] } {
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
  const rad = (bearingDeg * Math.PI) / 180;
  // unit vector along the road, and its perpendicular
  const ax = Math.sin(rad);
  const ay = Math.cos(rad);
  const px = -ay;
  const py = ax;
  const hw = widthM / 2;
  const ht = thicknessM / 2;
  const corners: [number, number][] = [
    [px * hw + ax * ht, py * hw + ay * ht],
    [px * hw - ax * ht, py * hw - ay * ht],
    [-px * hw - ax * ht, -py * hw - ay * ht],
    [-px * hw + ax * ht, -py * hw + ay * ht],
  ];
  const ring: LngLat[] = corners.map(([dx, dy]) => [
    lon + dx / mPerDegLon,
    lat + dy / M_PER_DEG_LAT,
  ]);
  ring.push(ring[0]);
  return { type: "Polygon", coordinates: [ring] };
}

/** Bearing in degrees at the start of a polyline — the direction of travel. */
export function headingOf(coords: LngLat[]): number {
  if (!Array.isArray(coords) || coords.length < 2) return 0;
  const [aLon, aLat] = coords[0];
  const [bLon, bLat] = coords[Math.min(1, coords.length - 1)];
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((aLat * Math.PI) / 180);
  const dx = (bLon - aLon) * mPerDegLon;
  const dy = (bLat - aLat) * M_PER_DEG_LAT;
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

/**
 * The driving centreline: the route line moved onto the forward carriageway,
 * vertex by vertex.
 *
 * PHASE 55 — the "corridor crosses into oncoming traffic" bug.
 *
 * buildCarriageway has always offset PER SPAN: splitByLanes cuts the route
 * wherever the lane count or the direction changes, and each span is shifted by
 * its own carriagewayOffsetM. The corridor did not. It took ONE shift, measured
 * from the single sample nearest the maneuver, and applied it to the whole
 * 250m slice.
 *
 * So the instant a slice spans a change — a two-way street feeding a one-way
 * roundabout is the common one, and the exact case in the field report — the
 * asphalt switched sides at the seam and the green ribbon did not. It starts on
 * the correct side and bends across the centre line on the approach, because
 * the shift belongs to the road at the far end, not the road underfoot.
 *
 * This resolves the offset at EVERY vertex and applies it there, so the ribbon
 * tracks the road it is actually on. Two details matter:
 *
 * SMOOTHING. A raw per-vertex offset steps by a full half-carriageway at a
 * seam. The step is geometrically honest — the driving line really does move
 * when a two-way road becomes one-way — but rendered as a hard jog it reads as
 * a glitch. The offsets are box-blurred over a short window so the ribbon eases
 * across instead.
 *
 * MITRE. offsetPolyline averages the two adjacent segment normals and
 * normalises, which yields the bisector but a perpendicular distance of only
 * d·cos(θ/2). At a 90° corner that is 71% of the intended offset, pulling the
 * line toward the inside of every bend. Here the bisector is scaled by the
 * mitre factor so the perpendicular distance is d whatever the turn, capped so
 * a hairpin can't throw a spike.
 */
/** Mitre length ceiling, as a multiple of the offset. Stops a hairpin spiking. */
const MITRE_CAP = 3;

export function drivingCentreline(
  coords: LngLat[],
  samples: LaneSample[],
  fallbackLanes: number,
  laneWidthM: number,
  smoothWindow = 4
): LngLat[] {
  if (!Array.isArray(coords) || coords.length < 2) return coords ?? [];

  // 1. target offset at each vertex, from the road under THAT vertex
  const raw: number[] = coords.map(([lon, lat]) => {
    const near = samples.length ? nearestSample(samples, lon, lat) : null;
    const lanes = near?.lanes && near.lanes > 0 ? near.lanes : fallbackLanes;
    // Unknown direction means two-way: that puts us on the right-hand
    // carriageway, where a driver actually is. Assuming oneway would straddle
    // the centre line, which is the worse error.
    return carriagewayOffsetM(lanes, !!near?.oneway, laneWidthM);
  });

  // 2. box blur so a seam eases rather than steps
  const off: number[] = raw.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let k = i - smoothWindow; k <= i + smoothWindow; k++) {
      if (k < 0 || k >= raw.length) continue;
      sum += raw[k];
      n++;
    }
    return n ? sum / n : raw[i];
  });

  // 3. shift each vertex along its mitred bisector
  const { toXY, toLngLat } = projector(coords[0][1]);
  const pts = coords.map(toXY);
  const out: LngLat[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = i > 0 ? segmentNormal(pts[i - 1], pts[i]) : null;
    const b = i < pts.length - 1 ? segmentNormal(pts[i], pts[i + 1]) : null;
    const d = off[i];

    let vx: number;
    let vy: number;
    if (a && b) {
      const mx = a[0] + b[0];
      const my = a[1] + b[1];
      const mlen = Math.hypot(mx, my); // = 2cos(theta/2)
      if (mlen < 1e-9) {
        // Doubled back on itself; fall back to the incoming normal.
        vx = a[0] * d;
        vy = a[1] * d;
      } else {
        // Move d/cos(theta/2) along the bisector: scale m by 2d/|m|^2.
        let scale = (2 * d) / (mlen * mlen);
        // Cap the mitre so a hairpin can't fling the vertex away.
        if (Math.abs(scale) * mlen > MITRE_CAP * Math.abs(d)) {
          scale = (MITRE_CAP * d) / mlen;
        }
        vx = mx * scale;
        vy = my * scale;
      }
    } else {
      const n = (a || b) as [number, number];
      vx = n[0] * d;
      vy = n[1] * d;
    }
    out.push(toLngLat([pts[i][0] + vx, pts[i][1] + vy]));
  }
  return out;
}

// lib/laneCorridor.ts — Phase 39: the highlighted lane corridor.
//
// The continuous glowing ribbon painted along the lane(s) the driver must be
// in for the next maneuver — the Amap/Baidu "active path" signature, and the
// element that turns a lane HUD into a road you can just follow.
//
// RELATIONSHIP TO THE EXISTING LANE STACK
//   laneAssist.ts    decides WHICH lanes serve the maneuver (valid: boolean)
//   laneArrows.ts    stamps a rotated arrow per lane, in rows before the junction
//   laneCorridor.ts  (this) fills the valid lanes with a continuous ribbon
// All three consume the SAME lane array in the SAME left-to-right order and the
// SAME 3.6m lane width, so they cannot disagree about where a lane is. Change
// the width in one place and you must change it in all three.
//
// PHASE 49: 3.6m remains the LANE width everywhere — the asphalt, the arrow
// spacing and this module all still agree on it. What changed is that the
// highlighted ribbon no longer FILLS its lane: it is inset by coreInsetM on
// each side (2.8m of ribbon in a 3.6m lane) so the white divider and a strip
// of asphalt stay visible, and it is emitted per lane rather than per run so
// two adjacent valid lanes read as two lanes instead of one slab.
//
// ---------------------------------------------------------------------------
// PHASE 40 CALIBRATION — measured, not guessed.
//
// Four real Gaode/Baidu captures were sampled pixel-wise (one night, three
// day). From the NIGHT capture, which is the one that matters for a dark theme:
//
//   corridor as rendered   #3BA58B   (dominant, ~1950px of 12k green samples)
//   their asphalt          #2F3C4F
//   chevrons inside it     #EBEEFF   (mean of pixels enclosed by corridor: #D8E9F0)
//   white road paint       #F3F5F4
//
// Our asphalt is DARKER than theirs (#12161F vs #2F3C4F), so copying their fill
// colour verbatim would render too dark. The fill was instead solved backwards
// from the composite so the FINAL pixel matches:
//
//   #17E8A8 @ 0.18 over #12161F  ->  #133C38   (glow)
//   #4CD4B0 @ 0.70 over #133C38  ->  #3BA68C   (core)  vs target #3BA58B
//
// Total error across all three channels: 2/255. The previous values (#3BF5B4
// @ 0.34) composited to roughly #1F8267 — far too dark and too cyan against
// the reference.
//
// WHAT ELSE THE CAPTURES CHANGED
//  - Chevrons. Every one of the four references paints repeating white chevrons
//    INSIDE the corridor. That is the single most recognisable part of the look
//    and it was missing entirely.
//  - End fade. The references hold full strength right up to the junction; only
//    the tail nearest the camera softens. The old ramp faded BOTH ends hard.
//  - Rim. A brighter line runs along the corridor edge in all four.
//
// WHY QUADS RATHER THAN ONE POLYGON PER RUN
// A fill layer has no gradient along its geometry — `fill-opacity` is constant
// across a feature. A single long polygon would start and stop with a hard
// edge. Emitting one quad per resampled step, each carrying a normalised `t`
// (0 at the driver end, 1 at the junction), lets the LAYER interpolate opacity
// on ["get","t"] and produce a soft tail for free.
//
// WHY A SEPARATE GLOW GEOMETRY
// Fill layers have no `fill-blur` (unlike `line-blur`, which the route ribbon
// uses). The emission is therefore geometric: the same ribbon built wider on
// each side, drawn underneath at low opacity.
//
// Pure module: no React, no MapLibre imports — unit-testable directly.

export type LngLat = [number, number];

/** Only `valid` is read; accepts laneAssist's TurnLane unchanged. */
export type CorridorLane = { valid: boolean };

export type CorridorFeature = {
  type: "Feature";
  properties: {
    /** 0 at the driver end of the ribbon, 1 at the junction. Drives the fade. */
    t: number;
  };
  geometry: { type: "Polygon"; coordinates: LngLat[][] };
};

export type RimFeature = {
  type: "Feature";
  properties: { t: number };
  geometry: { type: "LineString"; coordinates: LngLat[] };
};

export type CorridorCollection = {
  type: "FeatureCollection";
  features: CorridorFeature[];
};

export type RimCollection = {
  type: "FeatureCollection";
  features: RimFeature[];
};

export type LaneCorridor = {
  /** Crisp ribbon, held back from each lane edge by coreInsetM. */
  core: CorridorCollection;
  /** Same ribbon, widened — drawn under the core as the emission. */
  glow: CorridorCollection;
  /** Repeating white chevrons inside the ribbon, above the core. */
  chevrons: CorridorCollection;
  /** Brighter edge line down each side of the ribbon. */
  rim: RimCollection;
};

export type CorridorOptions = {
  /** Metres between quads. Smaller = smoother fade, more geometry. */
  stepM?: number;
  /**
   * How far back from the junction the ribbon runs. Beyond a couple of hundred
   * metres a lane highlight isn't actionable and the quads are wasted — the
   * carriageway bounds itself at 350m for the same reason.
   */
  maxLengthM?: number;
  /** Hard ceiling on quads per run, whatever the step works out to. */
  maxQuads?: number;
  /**
   * PHASE 49 — how far the ribbon is held back from each lane edge, per side.
   *
   * The ribbon used to span the full 3.6m lane, so its edge landed exactly on
   * the white divider and painted over it (the corridor draws ABOVE the
   * divider layers). On the road that read as a solid green block replacing
   * the lane rather than a glowing path painted inside it, and on wide
   * carriageways it flattened the sense of how many lanes there were.
   *
   * PHASE 50: raised 0.4 -> 0.65 on field feedback. 0.4 left a 2.8m ribbon,
   * which still read as a filled lane; 0.65 leaves 2.3m inside a 3.6m lane —
   * a sleek guiding laser INSIDE the lane, with 0.65m of raw asphalt and the
   * full white divider clear on each side, at 2, 3 or 5 lanes. Both derived
   * values follow automatically: the glow clamps to the inset (so the halo
   * still cannot reach the divider) and the chevrons rescale to ~1.66m.
   */
  /**
   * PHASE 54: 0.6 gives a 2.4m ribbon in a 3.6m lane — 0.6m of bare asphalt
   * either side, so both painted lines stay visible and the ribbon reads as a
   * thick glowing line INSIDE the lane rather than a resurfacing of it.
   */
  coreInsetM?: number;
  /**
   * Lateral padding on the glow ribbon, each side.
   *
   * PHASE 42: cut from 1.1m to 0.4m. At 1.1m the emission reached 31% of the
   * way across the NEIGHBOURING lane, tinting asphalt the driver is supposed to
   * be reading as a separate, available lane. 0.4m still softens the edge —
   * which is the only reason the second geometry exists, fill layers having no
   * fill-blur — without laying green over a lane the corridor doesn't own.
   */
  glowPadM?: number;
  /** Distance between chevron centres along the ribbon. */
  chevronSpacingM?: number;
  /** Chevron width. Reference reads ~60-70% of lane width. */
  chevronWidthM?: number;
  /** Chevrons are suppressed within this distance of either end. */
  chevronMarginM?: number;
};

const M_PER_DEG_LAT = 111320;

const EMPTY: LaneCorridor = {
  core: { type: "FeatureCollection", features: [] },
  glow: { type: "FeatureCollection", features: [] },
  chevrons: { type: "FeatureCollection", features: [] },
  rim: { type: "FeatureCollection", features: [] },
};

/**
 * Chevron outline in metres, local frame (x = right, y = forward), sized for a
 * 2.2m width. Two nested Vs — an outer leading edge and an inner trailing one —
 * which is the notched-tail shape the references paint, not a solid triangle.
 * Scaled by chevronWidthM/2.2 at build time.
 */
const CHEVRON: [number, number][] = [
  [-1.1, -0.35],
  [0.0, 0.75],
  [1.1, -0.35],
  [1.1, -0.9],
  [0.0, 0.2],
  [-1.1, -0.9],
];
const CHEVRON_REF_W = 2.2;

/** Local equirectangular projection, as laneGeometry does it. */
function projector(refLat: number) {
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((refLat * Math.PI) / 180);
  return {
    toXY: ([lon, lat]: LngLat): [number, number] => [lon * mPerDegLon, lat * M_PER_DEG_LAT],
    toLngLat: ([x, y]: [number, number]): LngLat => [x / mPerDegLon, y / M_PER_DEG_LAT],
  };
}

/**
 * The last `maxM` metres of a path in metre space, walking back from the END.
 *
 * Trimming from the end rather than the start is what anchors the ribbon to the
 * junction: as the driver closes in, the tail is consumed and the head stays
 * put, so the paint holds still in world space instead of sliding along with
 * the camera. Same reasoning as laneArrows' pointBackFromEnd.
 */
function tailOfPath(pts: [number, number][], maxM: number): [number, number][] {
  if (pts.length < 2) return pts;
  let remaining = maxM;
  const out: [number, number][] = [];
  for (let i = pts.length - 1; i > 0; i--) {
    const a = pts[i - 1];
    const b = pts[i];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (out.length === 0) out.push(b);
    if (L <= 0) continue;
    if (remaining <= L) {
      const f = (L - remaining) / L;
      out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
      break;
    }
    out.push(a);
    remaining -= L;
  }
  return out.reverse();
}

/** Uniform resample so every quad is the same length and no segment is degenerate. */
function resample(pts: [number, number][], stepM: number): [number, number][] {
  if (pts.length < 2 || stepM <= 0) return pts;
  const out: [number, number][] = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L <= 0) continue;
    let d = stepM - carry;
    while (d <= L) {
      const f = d / L;
      out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
      d += stepM;
    }
    carry = (carry + L) % stepM;
  }
  const last = pts[pts.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last[0] - tail[0], last[1] - tail[1]) > stepM * 0.25) out.push(last);
  else out[out.length - 1] = last;
  return out;
}

/**
 * Unit LEFT normal at every vertex, averaged across the two adjacent segments
 * so corners stay continuous.
 *
 * Computed here rather than reusing laneGeometry.offsetPolyline because that
 * function SKIPS degenerate vertices, which would desynchronise the left and
 * right boundary arrays — and the quads are built by pairing them index to
 * index. One normal per input vertex, unconditionally, is what makes that safe.
 */
function leftNormals(pts: [number, number][]): [number, number][] {
  const segN: [number, number][] = [];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0];
    const dy = pts[i][1] - pts[i - 1][1];
    const L = Math.hypot(dx, dy);
    segN.push(L < 1e-9 ? [0, 0] : [-dy / L, dx / L]);
  }
  const out: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = i > 0 ? segN[i - 1] : null;
    const b = i < segN.length ? segN[i] : null;
    let nx = (a ? a[0] : 0) + (b ? b[0] : 0);
    let ny = (a ? a[1] : 0) + (b ? b[1] : 0);
    const L = Math.hypot(nx, ny);
    if (L < 1e-9) {
      const f = b || a || [0, 0];
      nx = f[0];
      ny = f[1];
    } else {
      nx /= L;
      ny /= L;
    }
    out.push([nx, ny]);
  }
  return out;
}

/** Contiguous runs of valid lanes, as inclusive [start, end] index pairs. */
export function validRuns(lanes: CorridorLane[]): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1;
  for (let i = 0; i < lanes.length; i++) {
    if (lanes[i]?.valid) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      runs.push([start, i - 1]);
      start = -1;
    }
  }
  if (start >= 0) runs.push([start, lanes.length - 1]);
  return runs;
}

/**
 * Build the highlighted corridor for the valid lanes on the approach to the
 * junction at the END of `slice`.
 *
 * `lanes` is left-to-right as the driver faces the junction (lane 0 furthest
 * left) — the laneAssist convention, shared with laneArrows.
 *
 * Returns EMPTY when every lane is valid: highlighting the entire carriageway
 * distinguishes nothing, and a ribbon that's always on is a ribbon the driver
 * stops reading. laneAssist marks all lanes valid for straight-ahead maneuvers
 * and for single-lane roads, so this is the common case, not an edge case.
 */
export function buildLaneCorridor(
  slice: LngLat[],
  lanes: CorridorLane[],
  laneWidthM: number,
  opts: CorridorOptions = {}
): LaneCorridor {
  const {
    stepM = 5,
    maxLengthM = 250,
    maxQuads = 90,
    coreInsetM = 0.6,
    glowPadM = 0.25,
    chevronSpacingM = 8,
    chevronWidthM = 2.3,
    chevronMarginM = 6,
  } = opts;

  // The glow may soften the ribbon's edge but must never cross the lane edge
  // and re-cover the divider the inset just exposed. Clamping to the inset
  // makes "the ribbon stays inside its lane" an invariant of the geometry
  // rather than a property of whichever numbers happen to be configured.
  const effGlowPadM = Math.min(glowPadM, coreInsetM);
  // Keep the chevrons inside the (now narrower) ribbon. The calibrated 2.3m
  // was measured against a full-lane corridor; against a 2.8m ribbon it would
  // run right up to the rim. Derived, so widening the ribbon back restores it.
  const coreWidthM = Math.max(0, laneWidthM - 2 * coreInsetM);
  const effChevronWidthM = Math.min(chevronWidthM, coreWidthM * 0.72);

  const n = lanes.length;
  if (!Array.isArray(slice) || slice.length < 2 || n === 0) return EMPTY;

  const runs = validRuns(lanes);
  if (runs.length === 0) return EMPTY;
  // Every lane valid. Suppressed on a MULTI-lane road: highlighting the whole
  // carriageway distinguishes nothing, and five ribbons side by side is noise.
  //
  // PHASE 54 exempts the single-lane case. The rule was written in Phase 39
  // when the ribbon FILLED its lane, so painting the only lane really did mean
  // resurfacing the road. Since Phase 49 the ribbon is inset — 2.4m inside a
  // 3.6m lane — and on a one-lane street that reads as the route path, which is
  // what the Gaode captures show and what a driver on a Tiberias residential
  // street should still see. There is exactly one ribbon and no choice being
  // implied, so neither objection applies.
  if (n > 1 && runs.length === 1 && runs[0][0] === 0 && runs[0][1] === n - 1) return EMPTY;

  const { toXY, toLngLat } = projector(slice[0][1]);
  const full = slice.map(toXY);
  const tail = tailOfPath(full, maxLengthM);
  if (tail.length < 2) return EMPTY;

  let totalM = 0;
  for (let i = 1; i < tail.length; i++) {
    totalM += Math.hypot(tail[i][0] - tail[i - 1][0], tail[i][1] - tail[i - 1][1]);
  }
  if (totalM <= 0) return EMPTY;
  const effStep = Math.max(stepM, totalM / maxQuads);

  const path = resample(tail, effStep);
  if (path.length < 2) return EMPTY;
  const normals = leftNormals(path);

  const cum: number[] = [0];
  for (let i = 1; i < path.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  }
  const len = cum[cum.length - 1] || 1;

  const core: CorridorFeature[] = [];
  const glow: CorridorFeature[] = [];
  const chevrons: CorridorFeature[] = [];
  const rim: RimFeature[] = [];

  /** Position, forward unit vector and left normal at distance d along `path`. */
  const sampleAt = (d: number) => {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const a = path[i - 1];
    const b = path[i];
    const seg = cum[i] - cum[i - 1] || 1;
    const f = Math.max(0, Math.min(1, (d - cum[i - 1]) / seg));
    const p: [number, number] = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1;
    const fwd: [number, number] = [dx / L, dy / L];
    const nrm: [number, number] = [-fwd[1], fwd[0]]; // left of travel
    return { p, fwd, nrm };
  };

  // PHASE 49: emit one ribbon PER VALID LANE, not one per contiguous run.
  // A run of two valid lanes used to become a single 7.2m slab with the
  // divider between them buried underneath — the "solid block" the field
  // report described, and the reason adjacent lanes stopped reading as
  // separate lanes on wide roads. Per-lane ribbons keep every divider
  // visible, including the ones BETWEEN two highlighted lanes.
  const validLanes: number[] = [];
  for (const [a, b] of runs) for (let i = a; i <= b; i++) validLanes.push(i);

  for (const laneIdx of validLanes) {
    // Lane i spans left-units [(n/2 - i)w, (n/2 - i - 1)w]; positive is LEFT of
    // travel, matching laneGeometry.offsetPolyline's sign convention. Both
    // edges are pulled inward by coreInsetM so the ribbon sits INSIDE the lane.
    const leftEdge = (n / 2 - laneIdx) * laneWidthM - coreInsetM;
    const rightEdge = (n / 2 - laneIdx - 1) * laneWidthM + coreInsetM;
    // Unchanged by the inset — it cancels — so chevrons stay on the lane centre.
    const midOffset = (leftEdge + rightEdge) / 2;

    const emit = (into: CorridorFeature[], padM: number) => {
      const L = leftEdge + padM;
      const R = rightEdge - padM;
      for (let i = 0; i < path.length - 1; i++) {
        const p0 = path[i];
        const p1 = path[i + 1];
        const n0 = normals[i];
        const n1 = normals[i + 1];
        const ring: LngLat[] = [
          toLngLat([p0[0] + n0[0] * L, p0[1] + n0[1] * L]),
          toLngLat([p1[0] + n1[0] * L, p1[1] + n1[1] * L]),
          toLngLat([p1[0] + n1[0] * R, p1[1] + n1[1] * R]),
          toLngLat([p0[0] + n0[0] * R, p0[1] + n0[1] * R]),
        ];
        ring.push(ring[0]);
        into.push({
          type: "Feature",
          properties: { t: Math.min(1, (cum[i] + cum[i + 1]) / 2 / len) },
          geometry: { type: "Polygon", coordinates: [ring] },
        });
      }
    };

    emit(core, 0);
    emit(glow, effGlowPadM);

    // Edge lines. Pixel-width strokes rather than polygons: this is a highlight
    // on the boundary, not painted area, and it matches how lane-edge-lines and
    // the dividers are already drawn.
    for (const off of [leftEdge, rightEdge]) {
      const line: LngLat[] = path.map((p, i) =>
        toLngLat([p[0] + normals[i][0] * off, p[1] + normals[i][1] * off])
      );
      rim.push({
        type: "Feature",
        properties: { t: 1 },
        geometry: { type: "LineString", coordinates: line },
      });
    }

    // Chevrons, centred in the run and spaced at a fixed world interval so they
    // hold still on the road as the driver moves — the same anchoring rule the
    // ribbon and the arrows follow.
    const scale = effChevronWidthM / CHEVRON_REF_W;
    for (let d = chevronMarginM; d <= len - chevronMarginM; d += chevronSpacingM) {
      const { p, fwd, nrm } = sampleAt(d);
      const cx = p[0] + nrm[0] * midOffset;
      const cy = p[1] + nrm[1] * midOffset;
      const right: [number, number] = [fwd[1], -fwd[0]];
      const ring: LngLat[] = CHEVRON.map(([lx, ly]) =>
        toLngLat([
          cx + right[0] * lx * scale + fwd[0] * ly * scale,
          cy + right[1] * lx * scale + fwd[1] * ly * scale,
        ])
      );
      ring.push(ring[0]);
      chevrons.push({
        type: "Feature",
        properties: { t: Math.min(1, d / len) },
        geometry: { type: "Polygon", coordinates: [ring] },
      });
    }
  }

  return {
    core: { type: "FeatureCollection", features: core },
    glow: { type: "FeatureCollection", features: glow },
    chevrons: { type: "FeatureCollection", features: chevrons },
    rim: { type: "FeatureCollection", features: rim },
  };
}

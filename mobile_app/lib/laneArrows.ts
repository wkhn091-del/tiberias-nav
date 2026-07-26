// lib/laneArrows.ts — Phase 35: on-road lane turn arrows (the Gaode/Baidu
// ground-paint signature). One arrow per lane, stamped flat on the asphalt in
// rows before the junction, each rotated to that lane's indication.
//
// WHY POLYGONS, NOT SYMBOL GLYPHS OR ICONS:
//  - Glyphs: real arrow characters (←↑→, U+2190+) live far outside the 0-255
//    glyph range that both basemaps reliably serve — the Phase 2/28 field
//    finding that already forced the route chevrons onto "»" and the turn
//    marker onto ASCII. A symbol layer could only draw "<" and "^", which
//    reads as debug text, not road paint.
//  - Icons: v11 does export an Images component, but this project ships no
//    sprite assets, and raster icons scale as billboards rather than as true
//    ground area — paint should be geometry, not a sticker.
//  - A fill polygon IS ground paint: it is map geometry, so MapLibre
//    foreshortens it correctly at the 80° nav pitch for free — no
//    pitch-alignment props needed, because there is nothing to align.
//
// The arrow proportions follow real thermoplastic lane markings (~4.6m long,
// 1.2m head) so at nav zoom they read as part of the road, not as UI stuck to
// it. Those figures are measured from the Gaode/Baidu captures — see
// ARROW_OUTLINE below.
//
// Pure module: no React, no MapLibre imports — unit-tested directly.

export type LaneArrowSpec = {
  /** usable for the upcoming maneuver — drawn bright by the layer paint */
  valid: boolean;
  /**
   * Rotation of the arrow relative to the direction of travel, in degrees
   * clockwise — the same convention (and the same values) as the HUD's
   * LANE_ARROW_ROTATION table, so the road and the HUD can never disagree.
   */
  angleDeg: number;
};

type Position = [number, number]; // [lon, lat] — GeoJSON order, like the route

export type LaneArrowFeature = {
  type: "Feature";
  properties: { valid: 0 | 1 };
  geometry: { type: "Polygon"; coordinates: Position[][] };
};

export type LaneArrowCollection = {
  type: "FeatureCollection";
  features: LaneArrowFeature[];
};

const M_PER_DEG_LAT = 111320;

/**
 * Classic road-marking arrow in metres, pointing "forward" (+y in a local
 * x=right / y=forward frame).
 *
 * PHASE 40, measured from the Baidu day capture: white arrow blobs on the
 * asphalt were 11-19px wide against a lane pitch of 58-62px, i.e. a head about
 * 0.33 of lane width, or ~1.2m on a 3.6m lane. That also matches GB 5768.3,
 * which puts an urban straight-arrow head near 0.9-1.2m. The previous outline
 * was 1.8m — a full HALF the lane — which reads chunky and toy-like next to the
 * references, where the arrows are notably slender and elongated.
 *
 * Now: 4.6m long, 1.2m head, 0.42m shaft, head occupying the front ~29%.
 */
const ARROW_OUTLINE: [number, number][] = [
  [-0.21, -2.3],
  [-0.21, 0.95],
  [-0.6, 0.95],
  [0, 2.3],
  [0.6, 0.95],
  [0.21, 0.95],
  [0.21, -2.3],
];

function segLenM(a: Position, b: Position, latRef: number): number {
  const kx = M_PER_DEG_LAT * Math.cos((latRef * Math.PI) / 180);
  const dx = (b[0] - a[0]) * kx;
  const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

/**
 * The point `backM` metres BEFORE the end of `line`, plus the direction of
 * travel (compass degrees) at that point. Walking back from the END — the
 * maneuver point — keeps the arrows anchored to the junction, so they hold
 * still in world space as the driver approaches, exactly like paint. Returns
 * null when the line is shorter than backM: that row would land behind the
 * driver, so it simply isn't drawn.
 */
function pointBackFromEnd(
  line: Position[],
  backM: number
): { point: Position; bearingDeg: number } | null {
  if (line.length < 2) return null;
  let remaining = backM;
  for (let i = line.length - 1; i > 0; i--) {
    const a = line[i - 1];
    const b = line[i];
    const L = segLenM(a, b, b[1]);
    if (L <= 0) continue;
    if (remaining <= L) {
      const f = (L - remaining) / L; // fraction from a toward b
      const point: Position = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      const kx = M_PER_DEG_LAT * Math.cos((b[1] * Math.PI) / 180);
      const e = (b[0] - a[0]) * kx;
      const n = (b[1] - a[1]) * M_PER_DEG_LAT;
      const bearingDeg = ((Math.atan2(e, n) * 180) / Math.PI + 360) % 360;
      return { point, bearingDeg };
    }
    remaining -= L;
  }
  return null;
}

/** The arrow outline rotated to `headingDeg` (compass) and placed at `center`. */
function arrowRing(center: Position, headingDeg: number): Position[] {
  const rad = (headingDeg * Math.PI) / 180;
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);
  const kx = M_PER_DEG_LAT * Math.cos((center[1] * Math.PI) / 180);
  const ring = ARROW_OUTLINE.map(([x, y]) => {
    // local (x=right, y=forward) -> (east, north) for a compass heading:
    // forward = (sinθ, cosθ), right = (cosθ, -sinθ)
    const e = x * cos + y * sin;
    const n = -x * sin + y * cos;
    return [center[0] + e / kx, center[1] + n / M_PER_DEG_LAT] as Position;
  });
  ring.push(ring[0]); // close the ring — GeoJSON polygons require it
  return ring;
}

/**
 * Build the on-road arrows for the junction at the END of `slice`.
 *
 * `slice` is the stretch of route between the driver and the maneuver point
 * (the client already computes it for the maneuver beam). `lanes` is
 * left-to-right as the driver faces the junction — the laneAssist convention —
 * so lane 0 sits furthest left of the centreline. One arrow per lane per row;
 * rows that would land behind the driver are skipped.
 */
export function buildLaneArrows(
  slice: Position[],
  lanes: LaneArrowSpec[],
  laneWidthM: number,
  rowsBackM: number[]
): LaneArrowCollection {
  const features: LaneArrowFeature[] = [];
  const n = lanes.length;
  if (n === 0 || slice.length < 2) return { type: "FeatureCollection", features };

  for (const backM of rowsBackM) {
    const base = pointBackFromEnd(slice, backM);
    if (!base) continue;
    const rad = (base.bearingDeg * Math.PI) / 180;
    const rSin = Math.sin(rad);
    const rCos = Math.cos(rad);
    const kx = M_PER_DEG_LAT * Math.cos((base.point[1] * Math.PI) / 180);
    lanes.forEach((lane, i) => {
      // centre of lane i, metres to the RIGHT of the carriageway centreline
      const off = (i - (n - 1) / 2) * laneWidthM;
      const e = off * rCos;
      const nOff = -off * rSin;
      const center: Position = [
        base.point[0] + e / kx,
        base.point[1] + nOff / M_PER_DEG_LAT,
      ];
      features.push({
        type: "Feature",
        properties: { valid: lane.valid ? 1 : 0 },
        geometry: {
          type: "Polygon",
          coordinates: [arrowRing(center, base.bearingDeg + lane.angleDeg)],
        },
      });
    });
  }
  return { type: "FeatureCollection", features };
}

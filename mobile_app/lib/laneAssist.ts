// lib/laneAssist.ts
//
// Turn-lane synthesis.
//
// OSRM only reports `turn:lanes` where OSM has been tagged for it, which is a
// minority of junctions. Rather than hiding the lane HUD there, we SYNTHESISE a
// layout from two things we already know reliably:
//
//   1. the road's real physical lane count (from the OSM `lanes` corridor
//      lookup that already drives the carriageway width), and
//   2. the maneuver we're about to perform.
//
// The output is deliberately the exact shape OSRM returns, so the HUD renders
// real and synthesised layouts through one code path.
//
// ACCURACY NOTE
// The core rule — turns are made from the outermost lane on the side you're
// turning toward — is correct at the overwhelming majority of junctions,
// because that's how roads are built. It will be wrong at a minority: a
// junction with two right-turn lanes where we predict one, or a left-turn lane
// dropped in the middle of a carriageway. So synthesised layouts are marked
// `inferred`, and the UI labels them. Showing confident guidance is right;
// letting a driver believe a guess is verified is not.

export type TurnLane = { valid: boolean; indications: string[] };

/**
 * Traffic handedness. Israel drives on the RIGHT, which determines which side
 * exits, u-turns and kerbside arrivals live on. Flip this one constant to
 * support a left-hand-traffic country.
 */
const DRIVES_ON_RIGHT = true;

const LEFT_MODIFIERS = new Set(["left", "sharp left", "slight left"]);
const RIGHT_MODIFIERS = new Set(["right", "sharp right", "slight right"]);
const SLIGHT_MODIFIERS = new Set(["slight left", "slight right"]);

/**
 * Is this maneuver worth a lane HUD?
 *
 * "Continue straight on the same road" involves no lane decision, so showing a
 * panel for it is noise that trains the driver to ignore the panel. Everything
 * that genuinely requires being in a particular lane returns true.
 */
export function isSignificantManeuver(type?: string | null, modifier?: string | null): boolean {
  const t = String(type ?? "").toLowerCase();
  const m = String(modifier ?? "").toLowerCase();
  if (t === "arrive") return true;
  if (t.includes("roundabout") || t === "rotary") return true;
  if (t === "merge" || t === "fork" || t === "on ramp" || t === "off ramp") return true;
  if (t === "end of road") return true;
  if (m === "uturn") return true;
  // turn/continue/new name only matter when they actually change direction
  if (LEFT_MODIFIERS.has(m) || RIGHT_MODIFIERS.has(m)) return true;
  return false;
}

/** Which way the maneuver goes, collapsed to what lane choice depends on. */
type Side = "left" | "right" | "all";

function sideOf(type: string, modifier: string): Side {
  if (modifier === "uturn") return DRIVES_ON_RIGHT ? "left" : "right";
  if (type === "off ramp") {
    // Slip roads leave on the driving side unless the modifier says otherwise.
    if (LEFT_MODIFIERS.has(modifier)) return "left";
    if (RIGHT_MODIFIERS.has(modifier)) return "right";
    return DRIVES_ON_RIGHT ? "right" : "left";
  }
  if (type === "arrive") return DRIVES_ON_RIGHT ? "right" : "left"; // kerb side
  if (LEFT_MODIFIERS.has(modifier)) return "left";
  if (RIGHT_MODIFIERS.has(modifier)) return "right";
  return "all";
}

/** The arrow a serving lane should display. */
function indicationFor(type: string, modifier: string): string {
  if (modifier === "uturn") return "uturn";
  if (type === "arrive") return "straight";
  if (modifier && modifier !== "straight") return modifier;
  return "straight";
}

/**
 * How many lanes serve the maneuver.
 *
 * Wide roads commonly get a second dedicated turn lane, so on 4+ lanes we
 * predict two. Slight turns and forks are the road bending rather than a
 * junction, so nearly every lane continues through them — predicting a single
 * lane there would send drivers merging for no reason.
 */
function servingCount(n: number, type: string, modifier: string): number {
  if (SLIGHT_MODIFIERS.has(modifier) || type === "fork" || type === "merge") {
    return Math.max(1, n - 1);
  }
  if (type === "arrive" || modifier === "uturn") return 1;
  if (n >= 4) return 2;
  return 1;
}

/**
 * Synthesise a lane layout.
 *
 * Lanes are returned LEFT to RIGHT as the driver faces the junction, matching
 * OSRM's ordering so the HUD needs no special-casing.
 *
 * @param laneCount physical lanes in our direction of travel
 */
export function synthesizeTurnLanes(
  type: string | null | undefined,
  modifier: string | null | undefined,
  laneCount: number
): TurnLane[] {
  const t = String(type ?? "").toLowerCase();
  const m = String(modifier ?? "").toLowerCase();
  const n = Math.max(1, Math.min(6, Math.floor(laneCount) || 1));

  const side = sideOf(t, m);
  const indication = indicationFor(t, m);

  // Single-lane road: the lane necessarily serves the maneuver. Nothing to
  // choose, but the HUD still confirms the direction.
  if (n === 1) return [{ valid: true, indications: [indication] }];

  // Straight-ahead: no lane is wrong.
  if (side === "all") {
    return Array.from({ length: n }, () => ({ valid: true, indications: [indication] }));
  }

  const serving = Math.min(n, servingCount(n, t, m));
  const lanes: TurnLane[] = [];
  for (let i = 0; i < n; i++) {
    // index from the relevant edge: left turns count from lane 0, right turns
    // from the last lane
    const distanceFromEdge = side === "left" ? i : n - 1 - i;
    const isServing = distanceFromEdge < serving;
    if (isServing) {
      // A serving lane on a multi-lane road usually also permits straight on,
      // unless it's a dedicated turn pocket (the outermost of several).
      const alsoStraight = serving > 1 && distanceFromEdge === serving - 1 && t !== "arrive";
      lanes.push({
        valid: true,
        indications: alsoStraight ? [indication, "straight"] : [indication],
      });
    } else {
      lanes.push({ valid: false, indications: ["straight"] });
    }
  }
  return lanes;
}

export type LaneAssist = { lanes: TurnLane[]; inferred: boolean };

/**
 * Lane layout for a maneuver, ALWAYS returning something for a significant
 * maneuver — real OSM data when we have it, a synthesised layout otherwise.
 *
 * @param osrmLanes  lane data from OSRM, or null/empty when untagged
 * @param laneCount  physical lanes at the junction; null when unknown
 */
export function resolveLaneAssist(
  type: string | null | undefined,
  modifier: string | null | undefined,
  osrmLanes: TurnLane[] | null | undefined,
  laneCount: number | null
): LaneAssist | null {
  if (!isSignificantManeuver(type, modifier)) return null;

  if (Array.isArray(osrmLanes) && osrmLanes.length > 0) {
    return { lanes: osrmLanes, inferred: false };
  }

  // No physical lane count either (corridor lookup unavailable). Two lanes is
  // the safest urban assumption: it still communicates WHICH SIDE to be on,
  // which is the decision that actually matters, without implying a wide
  // multi-lane junction that may not exist.
  const n = laneCount && laneCount > 0 ? laneCount : 2;
  return { lanes: synthesizeTurnLanes(type, modifier, n), inferred: true };
}

/**
 * Project a lane-guidance array onto the PHYSICAL carriageway.
 *
 * PHASE 54 — the "corridor straddles the divider" bug, fourth attempt.
 *
 * Two different lane arrays were being drawn on the same asphalt:
 *
 *   the CARRIAGEWAY (asphalt, dividers, edge lines) is built from the physical
 *     count in the OSM sample — `lanes`, or `lanes:forward`, or a class default;
 *   the GUIDANCE (corridor ribbon, ground arrows) was built from laneAssist,
 *     whose length comes from OSRM `turn:lanes` and is frequently different.
 *
 * Both arrays get centred on the same line, so when the counts differ the
 * guidance is laid out to a width the road doesn't have. Measured, with a 1-lane
 * physical road and a 2-lane turn:lanes array, selecting the right-hand lane:
 *
 *     asphalt 0.0..3.6m   ribbon 4.25..6.55m   — entirely off the road surface
 *
 * The ribbon lands just outside the rightmost painted line, which is exactly
 * what "straddling the divider" looks like from the driver's seat. Phases 51-53
 * each moved the SHIFT around; none of them made the two arrays agree, so the
 * error kept coming back in a new place.
 *
 * This maps validity onto the lanes that are actually drawn. A guidance lane is
 * assigned to the physical lane its CENTRE falls in, so the geometry can never
 * index past the end of the carriageway:
 *
 *   2 guidance lanes onto 1 physical  -> both collapse to lane 0
 *   3 guidance lanes onto 2 physical  -> [0, 1, 1]
 *   equal counts                      -> identity
 *
 * Collapsing is the honest outcome: if the road has one lane, "get in the right
 * one" is not a decision the driver can act on, and painting a second ribbon
 * beside the road to represent it would be a fiction.
 *
 * @param lanes     guidance lanes, left-to-right as the driver faces the junction
 * @param physical  lanes actually drawn on the carriageway (>= 1)
 */
export function mapLanesOntoCarriageway(
  lanes: TurnLane[],
  physical: number
): TurnLane[] {
  const p = Math.max(1, Math.floor(physical));
  if (!Array.isArray(lanes) || lanes.length === 0) return [];
  if (lanes.length === p) return lanes;

  const out: TurnLane[] = Array.from({ length: p }, () => ({
    valid: false,
    indications: [] as string[],
  }));
  lanes.forEach((ln, i) => {
    const idx = Math.min(p - 1, Math.floor(((i + 0.5) / lanes.length) * p));
    const slot = out[idx];
    // A physical lane is valid if ANY guidance lane folded into it was valid,
    // and inherits that lane's indications so the arrow still points correctly.
    if (ln.valid && !slot.valid) {
      slot.valid = true;
      slot.indications = ln.indications;
    } else if (slot.indications.length === 0) {
      slot.indications = ln.indications;
    }
  });
  return out;
}

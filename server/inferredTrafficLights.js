"use strict";

// ---------- brute-force inferred traffic lights (Phase 36) --------------------
//
// WHY THIS REPLACED THE PHASE 35 HEURISTIC
//
// Phase 35 already loosened the maneuver gate to "any turn onto any real
// street". It still produced zero lights in Tiberias, and the reason was not
// the gate — it was the ROAD-EVIDENCE lookup behind it.
//
// synthesizeSignals() required a corridor probe within SIGNAL_SYNTH_MATCH_M of
// every maneuver before it would emit anything. Those probes come from
// fetchRouteCorridor(), which returns EMPTY_CORRIDOR ({signals:[], probes:[],
// laneSamples:[]}) whenever the Overpass breaker is open. With probes empty the
// nearest-probe scan never runs, `best` stays null, and EVERY maneuver is
// rejected by `if (!best || bestD > SIGNAL_SYNTH_MATCH_M) continue`.
//
// So the inferred-light feature was silently coupled to Overpass availability:
// the moment the public instance rate-limited us, inference went to zero at the
// same time real signals did. Both halves of the feature failed together, which
// is exactly the case inference exists to cover.
//
// THIS MODULE has no Overpass dependency at all. It reads the OSRM maneuver
// list — which is already parsed, validated and distance-pinned by
// buildDynamicRoute() — and emits a light at every junction-like maneuver,
// unconditionally. It therefore keeps working with the breaker wide open.
//
// THE HONESTY CONTRACT IS UNCHANGED. Everything here is flagged inferred:true,
// which the client already renders dimmer (circle-opacity 0.12 vs 0.22) and
// labels "רמזור משוער" in the countdown card. Density is only defensible
// because the labelling is — that trade is inherited from Phase 35, not
// weakened here.

// Maneuver types that are definitionally not junctions. Everything else
// qualifies. A deny-list rather than an allow-list is the point: brute force
// means a type we forgot to enumerate still gets a light instead of silently
// producing another zero-light route.
const NON_JUNCTION_TYPES = new Set(["depart", "arrive", "notification"]);

/**
 * OSRM's roundabout family: "roundabout", "rotary", "roundabout turn",
 * "exit roundabout", "exit rotary".
 */
function isRoundaboutFamily(type) {
  return type.includes("roundabout") || type.includes("rotary");
}

/**
 * Local copy of server.js's haversineM, so this module stays dependency-free
 * and unit-testable on its own. Same formula, same argument order.
 */
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(toRad(lat1)) * Math.cos(toRad(lat2));
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Infer a traffic light at every junction-like maneuver on the route.
 *
 * @param {Array}  maneuvers    entry.maneuvers from buildDynamicRoute():
 *                              { type, modifier, name, exit, alongM, lon, lat, lanes }
 *                              — `type` is already lowercased there.
 * @param {Array}  realSignals  clustered OSM signals { id, lon, lat, count, inferred:false }.
 *                              Used only to avoid doubling up on a surveyed light.
 * @param {object} [opts]
 *   @param {number}  opts.stackRadiusM      collapse inferred lights closer than this
 *                                           to each other (z-fighting guard).
 *   @param {number}  opts.realRadiusM       suppress an inferred light this close to a
 *                                           real one.
 *   @param {boolean} opts.includeRoundabouts treat roundabout-family maneuvers as
 *                                           junctions even when the modifier is
 *                                           "straight" or absent.
 *   @param {number}  opts.maxLights         hard ceiling per route (0 = unlimited).
 *   @param {boolean} opts.silent            suppress the summary log line.
 *
 * @returns {Array} signals in the client's TrafficSignal shape:
 *                  { id, lon, lat, count, inferred:true }
 *
 * Pure and order-stable — same input, same output, no I/O. Directly testable,
 * like clusterSignals().
 */
function synthesizeInferredSignals(maneuvers, realSignals, opts = {}) {
  const {
    stackRadiusM = 12,
    realRadiusM = 40,
    includeRoundabouts = true,
    maxLights = 400,
    silent = false,
  } = opts;

  const stats = {
    maneuvers: 0,
    rejectedType: 0,
    rejectedStraight: 0,
    rejectedBadCoord: 0,
    rejectedStacked: 0,
    rejectedOnReal: 0,
    rejectedCapped: 0,
    emitted: 0,
  };

  if (!Array.isArray(maneuvers) || maneuvers.length === 0) {
    if (!silent) console.log("[synth] no maneuvers on this route — 0 inferred lights");
    return [];
  }

  const real = Array.isArray(realSignals) ? realSignals : [];
  const out = [];

  for (const mv of maneuvers) {
    stats.maneuvers++;

    const type = String(mv.type || "").toLowerCase();
    const mod = String(mv.modifier || "").toLowerCase();

    if (NON_JUNCTION_TYPES.has(type)) {
      stats.rejectedType++;
      continue;
    }

    // The one substantive filter that survives from Phase 35: a maneuver that
    // carries you straight through is not a turn. Roundabouts are exempt when
    // includeRoundabouts is on, because OSRM routinely tags a roundabout entry
    // "straight" — dropping those was silently costing real junctions.
    if (mod === "straight" && !(includeRoundabouts && isRoundaboutFamily(type))) {
      stats.rejectedStraight++;
      continue;
    }

    // Roundabouts with no modifier at all are still junctions when the flag is
    // on; with it off they fall through to the same straight-through rule.
    if (!includeRoundabouts && isRoundaboutFamily(type)) {
      stats.rejectedType++;
      continue;
    }

    const lat = mv.lat;
    const lon = mv.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      stats.rejectedBadCoord++;
      continue;
    }

    // Already surveyed? A real light stays the real light — an inferred twin
    // beside it would render a second, dimmer icon at one junction.
    if (real.some((t) => haversineM(lat, lon, t.lat, t.lon) <= realRadiusM)) {
      stats.rejectedOnReal++;
      continue;
    }

    // Stacking guard. OSRM emits two steps at one physical junction constantly
    // — "roundabout" immediately followed by "exit roundabout" a few metres
    // apart, or "turn" followed by "new name". Rendered raw at 80° pitch those
    // z-fight into one smeared icon.
    if (out.some((s) => haversineM(lat, lon, s.lat, s.lon) <= stackRadiusM)) {
      stats.rejectedStacked++;
      continue;
    }

    if (maxLights > 0 && out.length >= maxLights) {
      stats.rejectedCapped++;
      continue;
    }

    out.push({
      // Same id scheme as the Phase 34 synthesiser: coordinate-derived, so it
      // stays stable across refetches and keeps React keys consistent.
      id: `syn-${lat.toFixed(5)},${lon.toFixed(5)}`,
      lon,
      lat,
      count: 1,
      inferred: true,
    });
    stats.emitted++;
  }

  if (!silent) {
    console.log(
      `[synth] ${stats.maneuvers} maneuver(s) -> ${stats.emitted} inferred light(s) ` +
        `| rejected: type=${stats.rejectedType} straight=${stats.rejectedStraight} ` +
        `badcoord=${stats.rejectedBadCoord} stacked=${stats.rejectedStacked} ` +
        `on-real=${stats.rejectedOnReal} capped=${stats.rejectedCapped}`
    );
  }

  return out;
}

module.exports = {
  synthesizeInferredSignals,
  isRoundaboutFamily,
  NON_JUNCTION_TYPES,
};

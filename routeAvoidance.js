"use strict";

// routeAvoidance.js — pick the best OSRM candidate under the driver's
// avoidance preferences.
//
// ---------------------------------------------------------------------------
// WHAT OSRM CAN AND CANNOT DO, because the split decides the architecture
//
// CAN, via the `exclude` query parameter:
//   toll, motorway, ferry — but ONLY these, and only because the stock car.lua
//   profile declares them:  excludable = Sequence { Set{'toll'}, Set{'motorway'},
//   Set{'ferry'} }. Ask for anything else and OSRM returns InvalidValue.
//
// CANNOT, at all:
//   * avoid a polygon. There is no such parameter. Every "avoid area" feature in
//     every OSRM-backed product is built on top, not inside.
//   * avoid unpaved surfaces. `surface=unpaved` is not an excludable class, and
//     adding one means recompiling the planet with a custom profile.
//
// So this module does the two things OSRM won't, using data we already fetch:
//
//   ZONES     ask OSRM for alternatives, then test each candidate line against
//             the zone polygons with Turf and take the first clean one.
//   UNPAVED   the corridor lookup already pulls `out tags` for every way on the
//             route (that is how maxspeed and lanes arrive). `surface` is in
//             that same payload and was simply being discarded.
// ---------------------------------------------------------------------------

const turf = require("@turf/turf");

/**
 * Surfaces that count as unpaved.
 *
 * `unknown` is deliberately absent: most Israeli roads carry no surface tag at
 * all, and treating untagged as unpaved would reject nearly every route. An
 * absent tag means we don't know, and we do not act on what we don't know.
 */
const UNPAVED_SURFACES = new Set([
  "unpaved",
  "gravel",
  "fine_gravel",
  "dirt",
  "earth",
  "ground",
  "sand",
  "mud",
  "grass",
  "compacted",
  "pebblestone",
]);

/**
 * Reasons a zone may exist. Every zone MUST declare one.
 *
 * This is not bookkeeping. A routing exclusion is a claim that a driver should
 * not be sent somewhere, and the only defensible basis for that claim is a
 * verifiable one: a legal access restriction, a closed road, a published
 * hazard, or the driver's own choice. Requiring `reason` — and `authority` for
 * legal ones — keeps the dataset auditable and keeps it from quietly becoming
 * a list of places based on who lives there rather than on what the law or the
 * road conditions say.
 *
 *   legal-restriction  entry is prohibited by law or military order.
 *                      In Israel the common case is Area A of the West Bank,
 *                      which Israeli citizens may not enter — signposted, and
 *                      a real routing hazard worth engineering around.
 *   closed-road        physically or temporarily impassable.
 *   hazard             an official advisory: flooding, fire, landslide.
 *   user               the driver drew it themselves.
 */
const ZONE_REASONS = new Set(["legal-restriction", "closed-road", "hazard", "user"]);

/**
 * Validate and normalise a zone FeatureCollection.
 *
 * Rejects rather than repairs. A malformed avoidance zone silently dropped is
 * a route through somewhere the driver asked not to go; a malformed zone that
 * throws at load is a log line before anyone drives anywhere.
 */
function loadZones(geojson) {
  const out = [];
  const errors = [];
  const features = geojson && Array.isArray(geojson.features) ? geojson.features : [];

  features.forEach((f, i) => {
    const id = f?.properties?.id || `zone-${i}`;
    const g = f?.geometry;
    if (!g || (g.type !== "Polygon" && g.type !== "MultiPolygon")) {
      errors.push(`${id}: geometry must be Polygon or MultiPolygon, got ${g?.type ?? "none"}`);
      return;
    }
    const reason = f?.properties?.reason;
    if (!ZONE_REASONS.has(reason)) {
      errors.push(`${id}: reason must be one of ${[...ZONE_REASONS].join("|")}, got ${reason ?? "none"}`);
      return;
    }
    if (reason === "legal-restriction" && !f?.properties?.authority) {
      errors.push(`${id}: reason "legal-restriction" requires an "authority" citing the order or statute`);
      return;
    }
    out.push({
      id,
      name: f.properties.name || id,
      reason,
      authority: f.properties.authority || null,
      feature: { type: "Feature", properties: {}, geometry: g },
    });
  });

  return { zones: out, errors };
}

/** Does this route line enter any zone? Returns the zones hit. */
function zonesHitBy(lineCoords, zones) {
  if (!Array.isArray(lineCoords) || lineCoords.length < 2 || !zones.length) return [];
  const line = turf.lineString(lineCoords);
  const hits = [];
  for (const z of zones) {
    try {
      if (turf.booleanIntersects(line, z.feature)) hits.push(z);
    } catch {
      // A malformed polygon that slipped validation must not take down routing.
      // Skipping it is the safe direction: worst case we fail to avoid, which
      // is the behaviour before this feature existed.
    }
  }
  return hits;
}

/**
 * Unpaved stretches on a route, from corridor lane samples.
 *
 * Takes the SAME samples the lane and speed-limit code already consumes, so
 * this costs no extra Overpass traffic — the surface tag arrives in the payload
 * either way.
 */
function unpavedCount(samples) {
  if (!Array.isArray(samples)) return 0;
  let n = 0;
  for (const s of samples) {
    const surface = String(s?.surface ?? "").toLowerCase();
    if (surface && UNPAVED_SURFACES.has(surface)) n++;
  }
  return n;
}

/**
 * Score a candidate. Lower is better; null means disqualified.
 *
 * Zones are a hard reject and unpaved is a soft penalty, and the asymmetry is
 * deliberate. A legal-restriction zone is a place the driver must not be sent;
 * an unpaved kilometre is a place they would rather not be sent. Treating the
 * second as fatal would strand anyone whose destination is genuinely down a
 * dirt track.
 */
function scoreCandidate(candidate, opts) {
  const { zones = [], avoidUnpaved = false } = opts;
  const hits = zonesHitBy(candidate.geometry?.coordinates, zones);
  if (hits.length) return { score: null, zoneHits: hits, unpaved: 0 };

  const unpaved = avoidUnpaved ? unpavedCount(candidate.laneSamples) : 0;
  // Duration is the baseline; each unpaved sample adds a minute of notional
  // cost, enough to lose to a modestly longer paved alternative but not enough
  // to prefer an absurd detour.
  const score = (candidate.durationS ?? 0) + unpaved * 60;
  return { score, zoneHits: [], unpaved };
}

/**
 * Choose among OSRM candidates.
 *
 * Returns the winner plus why it won, so the caller can tell the driver
 * something truthful ("routed around a restricted area") rather than silently
 * handing back a longer route.
 */
function chooseRoute(candidates, opts = {}) {
  if (!Array.isArray(candidates) || !candidates.length) {
    return { chosen: null, reason: "no-candidates", rejected: [] };
  }

  const scored = candidates.map((c, i) => ({ i, c, ...scoreCandidate(c, opts) }));
  const viable = scored.filter((s) => s.score !== null);
  const rejected = scored.filter((s) => s.score === null);

  if (!viable.length) {
    // Every option crosses a zone. Hand back the first anyway, flagged: refusing
    // to navigate at all is worse than navigating with a warning, and the driver
    // may have no lawful alternative route to their destination.
    return {
      chosen: candidates[0],
      reason: "all-candidates-blocked",
      blockedBy: rejected[0]?.zoneHits ?? [],
      rejected: rejected.map((r) => r.i),
    };
  }

  viable.sort((a, b) => a.score - b.score);
  const best = viable[0];
  return {
    chosen: best.c,
    reason: rejected.length ? "avoided-zone" : best.unpaved ? "avoided-unpaved" : "direct",
    avoidedZones: rejected.flatMap((r) => r.zoneHits.map((z) => z.name)),
    unpavedSamples: best.unpaved,
    rejected: rejected.map((r) => r.i),
  };
}

/** OSRM `exclude` values for the given prefs. Only classes stock OSRM knows. */
function osrmExcludes(prefs = {}) {
  const out = [];
  if (prefs.avoidToll) out.push("toll");
  if (prefs.avoidFerry) out.push("ferry");
  // NOT avoidUnpaved — see the header. It is handled by scoring, not by OSRM.
  return out;
}

module.exports = {
  loadZones,
  zonesHitBy,
  unpavedCount,
  scoreCandidate,
  chooseRoute,
  osrmExcludes,
  UNPAVED_SURFACES,
  ZONE_REASONS,
};

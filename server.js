// server.js — Phase 5: telemetry + routing + auto-reroute + structured autocomplete search
//
// Boot order: mongod running -> `python extract_route_90.py` (seeds Highway 90)
//             -> `npx nodemon server.js`
// Without a seeded route the server runs in log-only mode; routing, search and
// auto-reroute never touch MongoDB.
//
// WebSocket protocol (/track):
//   client -> server  telemetry ping   {deviceId, lon, lat, speed, heading, accuracy, ts}
//   client -> server  suggestions      {type:"search_suggest", deviceId, query}
//   client -> server  traffic report   {type:"traffic_report", deviceId, reportType, location:[lon,lat]}
//   server -> clients broadcast        {type:"traffic_report", id, reportType, location, deviceId, ts}
//   server -> sender  ack              {type:"report_ack", id}
//   client -> server  category search  {type:"category_search", category:"food"|"gas"|"parking"|"emergency"|..., lat, lon}
//   client -> server  routing prefs    {type:"set_destination", ..., routePrefs:{avoidToll,avoidUnpaved,avoidZones}}
//   server -> client  route notice     {type:"route_notice", message, level?}
//   server -> sender  category results {type:"category_results", category, items:[{name, detail, lon, lat, distanceM}]}
//   client -> server  recent searches  {type:"get_recent_searches", deviceId}
//   client -> server  clear history    {type:"clear_search_history", deviceId}
//   client -> server  delete one       {type:"delete_search_history_item", deviceId, name, lon, lat}
//   client -> server  vote on report   {type:"vote_report", deviceId, reportId, vote:"up"|"down"}
//   server -> sender  vote ack         {type:"vote_ack", reportId, score, counted}
//   server -> clients report retired   {type:"report_removed", reportId}
//   server -> sender  cleared ack      {type:"recent_searches_results", items:[], cleared:true}
//   server -> sender  recent results   {type:"recent_searches_results", items:[{name, lon, lat}]}
//   server -> driver  proximity alert  {type:"proximity_alert", reportId, reportType, distanceMeters, message}
//   client -> server  profile          {type:"get_profile", deviceId}
//   server -> sender  profile results  {type:"profile_results", points, totalDistanceKm, rank, persisted}
//   server -> driver  live map         {type:"nearby_drivers", drivers:[{deviceId,lon,lat,heading,speed,rank,distanceM}], ts}
//   client -> server  save place       {type:"save_place", deviceId, label, address, lat, lon}
//   client -> server  delete place     {type:"delete_place", deviceId, placeId|label}
//   server -> sender  places updated   {type:"saved_places", places:[{placeId,label,address,lat,lon}], saved?|deleted?}
//   server -> sender  place error      {type:"place_error", message}
//   client -> server  honk / like      {type:"send_interaction", deviceId, targetDeviceId, interactionType:"honk"|"like"}
//   server -> target  interaction      {type:"incoming_interaction", interaction:"honk"|"like", fromRank, ts}
//   server -> sender  interaction ack  {type:"interaction_sent", interaction, targetDeviceId}
//   server -> sender  interaction err  {type:"interaction_error", message}
//   server -> driver  traffic signals  {type:"route_signals", signals:[{id,lon,lat}]}  (follows new_route)
//   server -> driver  lane counts      {type:"route_lanes", samples:[{lat,lon,lanes,highway,tagged,oneway}]}  (same lookup)
//   (status.maneuver additionally carries lanes:[{valid,indications[]}] for the lane-assist HUD)
//   client -> server  set destination  {type:"set_destination", deviceId,
//                                       destination:[lon,lat] (+ destinationName?)
//                                       OR query:"free text", origin?:[lon,lat],
//                                       profile?:"car"|"motorcycle"|"foot"}
//   server -> client  verdict          {type:"status", onRoute, distanceM, progressM, progressPct,
//                                       remainingM, remainingS, route}
//   server -> client  suggestions      {type:"suggestions", query, items:[{name, detail, lon, lat}]}
//   server -> client  active route     {type:"new_route", feature, destination, destinationName, rerouted}
//   server -> client  routing failed   {type:"route_error", message}
//   server -> client  glitch rejected  {type:"rejected", reason}
//
// Nominatim policy note: the public endpoint forbids raw autocomplete, so all
// geocoder traffic funnels through a global >=1.1s gate + a result cache, and
// suggestion taps route by coordinates (no second geocode). For production,
// point NOMINATIM_URL at a self-hosted instance or a commercial geocoder.

const express = require("express");
const { WebSocketServer, WebSocket } = require("ws");
const mongoose = require("mongoose");
const turf = require("@turf/turf");
// Phase 36: brute-force inferred traffic lights. Local module, no deps — see
// inferredTrafficLights.js for why the Phase 35 heuristic produced zero lights.
const { synthesizeInferredSignals } = require("./inferredTrafficLights");
const { loadZones, chooseRoute, osrmExcludes } = require("./routeAvoidance");
const { loadCustomSignals, mergeSignals } = require("./customSignals");
const fs = require("fs");
const path = require("path");

// ---------- custom traffic-light dataset (Phase 73) ----------
// Produced by tools/ingest-signals.mjs from municipal / open-data GIS. Absent
// is normal until someone runs the ingester; the OSM path carries on either
// way, so this is additive rather than a replacement.
const CUSTOM_SIGNALS = loadCustomSignals(
  process.env.SIGNALS_FILE || path.join(__dirname, "signals.json")
);

// ---------- avoidance zones (Phase 70) ----------
// Loaded once at boot from AVOID_ZONES_FILE, or zones.json beside this file.
// Absent is the normal case and not an error: the app ships with no zones, and
// the operator supplies them. Malformed ones are reported loudly — a zone that
// fails to load is a route through somewhere the driver asked to avoid.
const AVOID_ZONES = (() => {
  const file = process.env.AVOID_ZONES_FILE || path.join(__dirname, "zones.json");
  if (!fs.existsSync(file)) {
    console.log(`[zones] none loaded (${file} not present) — avoidance disabled`);
    return [];
  }
  try {
    const { zones, errors } = loadZones(JSON.parse(fs.readFileSync(file, "utf8")));
    errors.forEach((e) => console.warn(`[zones] REJECTED ${e}`));
    console.log(`[zones] ${zones.length} loaded from ${file}`);
    zones.forEach((z) => console.log(`[zones]   ${z.id} (${z.reason}${z.authority ? ": " + z.authority : ""})`));
    return zones;
  } catch (err) {
    console.warn(`[zones] failed to read ${file}: ${err.message} — avoidance disabled`);
    return [];
  }
})();

if (typeof fetch !== "function") {
  console.error(`Node 18+ is required (global fetch). Current: ${process.version}`);
  process.exit(1);
}

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/highway90";

// ---- PHASE 57: never let a missing database hang the process ----------------
//
// THE BUG THIS FIXES, exactly as it appeared in the Render logs:
//
//   Mongo unavailable — running without persistence: connect ECONNREFUSED ...
//   route load failed: Operation `routes.findOne()` buffering timed out after 10000ms
//
// Mongoose buffers commands by default. A query issued while disconnected is
// not rejected — it is QUEUED, and only fails once bufferTimeoutMS (10s)
// expires. So a server that has correctly decided to run without persistence
// still parks every query for ten seconds before discovering what it already
// knew, and under a 2s ping stream those parked promises pile up.
//
// Turning buffering off converts every one of those hangs into an instant,
// catchable rejection. This single line is what stops the freeze; the
// mongoReady()/withDb() guards below stop the noise.
mongoose.set("bufferCommands", false);
// Cloud platforms (Railway/Render/Fly) inject PORT; 3000 is the local default
// and MUST match DEFAULT_PORT in mobile_app/lib/serverHost.ts.
const PORT = process.env.PORT || 3000;
// Bind on all interfaces. Node already defaults to this when no host is passed,
// but cloud platforms (Railway/Render/Fly) health-check from outside the
// container, so being explicit removes any doubt — and makes it obvious to the
// next reader that binding to 127.0.0.1 would black-hole all external traffic.
const HOST = process.env.HOST || "0.0.0.0";
// ---- Routing profiles (Phase 29) --------------------------------------------
// VERIFIED, and it is not what the OSRM docs imply. An osrm-routed process
// serves exactly ONE profile, and the {profile} path segment is never
// validated — router.project-osrm.org answers /route/v1/foot/... and
// /route/v1/bike/... with the SAME car route it always returns. Selecting a
// vehicle by editing that path segment therefore produces a feature that looks
// like it works and silently lies (walking ETAs at car speed).
//
// FOSSGIS runs the real thing at routing.openstreetmap.de: three separate
// worldwide engines (car, bike, foot) chosen by a HOST PREFIX — routed-car /
// routed-bike / routed-foot — while the path segment stays "driving" for all
// of them. That is the contract we use. Point OSRM_BASE_URL at a self-hosted
// deployment and the same prefixes apply if you run one process per profile.
const OSRM_BASE_URL = process.env.OSRM_BASE_URL || "https://routing.openstreetmap.de";
// Wire value -> FOSSGIS engine prefix.
// NOTE on motorcycle: mapped to the bike engine per product spec. A motorcycle
// is legally a motor vehicle, so the bike engine will prefer cycle paths and
// return cycling-speed ETAs (~15 km/h vs ~60). Set MOTORCYCLE_PROFILE=car to
// route motorcycles as cars (accurate ETAs, no cycle paths) — one env flip.
const MOTORCYCLE_ENGINE = process.env.MOTORCYCLE_PROFILE === "car" ? "routed-car" : "routed-bike";
const OSRM_PROFILE_ENGINE = {
  car: "routed-car",
  motorcycle: MOTORCYCLE_ENGINE,
  foot: "routed-foot",
};
const DEFAULT_PROFILE = "car";
// FOSSGIS usage policy is an explicit max of 1 request/second, so the gate sits
// just above 1000 ms (was 600 ms against the old host, which would breach it).
const OSRM_MIN_GAP_MS = Number(process.env.OSRM_MIN_GAP_MS || 1100);
const NOMINATIM_URL = process.env.NOMINATIM_URL || "https://nominatim.openstreetmap.org";
const NOMINATIM_LANG = process.env.NOMINATIM_LANG || "he,en";
// left,top,right,bottom lon/lat bias box (wider Kinneret area); "" disables
const SEARCH_VIEWBOX = process.env.SEARCH_VIEWBOX ?? "35.40,32.95,35.70,32.55";
const ROUTE_SLUG = "hwy90-tiberias";
const ON_ROUTE_THRESHOLD_M = 30;
const MAX_PLAUSIBLE_SPEED_MS = 70;
const DYNAMIC_ROUTE_TTL_MS = 6 * 60 * 60 * 1000;
const REROUTE_AFTER_OFF_PINGS = 3;
const REROUTE_COOLDOWN_MS = Number(process.env.REROUTE_COOLDOWN_MS || 15000);
// ---- Anti-jitter off-route guards (Phase 29, field fix) ----------------------
// Field report: standing in a parking lot with a ±112 m fix, the driver was
// repeatedly declared off-route (the flat 30 m corridor is meaningless when the
// position itself is uncertain by 112 m), which fired reroute after reroute —
// each one computed from a garbage origin, so it never converged. Three guards:
//
//  1. JITTER GATE — crawling AND imprecise means we simply cannot tell whether
//     the driver left the road, so we refuse to answer. No off-route verdict,
//     no reroute, until either the speed or the fix quality recovers.
//  2. ACCURACY-AWARE CORRIDOR — widen the corridor by the fix's own error
//     radius. Claiming "30 m off course" from a ±112 m fix is false precision.
//  3. START GRACE — a just-issued route usually begins in an unmapped car park
//     or driveway, so the first stretch gets a generous corridor to let the
//     driver reach the road network without the app panicking.
const REROUTE_MIN_SPEED_MS = Number(process.env.REROUTE_MIN_SPEED_MS || 2.78); // 10 km/h
const REROUTE_MAX_ACCURACY_M = Number(process.env.REROUTE_MAX_ACCURACY_M || 40);
const OFF_ROUTE_ACCURACY_CAP_M = Number(process.env.OFF_ROUTE_ACCURACY_CAP_M || 120);
const ROUTE_START_GRACE_MS = Number(process.env.ROUTE_START_GRACE_MS || 90000);
const ROUTE_START_GRACE_M = Number(process.env.ROUTE_START_GRACE_M || 80);
const SUGGEST_MIN_CHARS = 3;
const SUGGEST_CACHE_TTL_MS = 10 * 60 * 1000;
const NOMINATIM_MIN_GAP_MS = 1100; // public-server policy: max 1 request/second
// Traffic reports: whitelist matches the client's REPORT_OPTIONS types, and a
// per-connection cooldown blunts spam — every accepted report fans out to
// every connected client, so this endpoint is an amplification vector.
const REPORT_TYPES = new Set(["Police", "Accident", "Hazard", "Traffic Jam"]);
const REPORT_COOLDOWN_MS = Number(process.env.REPORT_COOLDOWN_MS || 5000);

// ---------- automatic congestion detection (Phase 23) ----------
// Auto-generated jams reuse the EXISTING "Traffic Jam" vocabulary rather than a
// new "traffic_jam" slug. The client resolves a report's Hebrew label and icon
// by exact string match against its REPORT_OPTIONS table, so a new slug would
// surface in the UI as the raw text "traffic_jam" with a fallback icon, and
// would also fail the manual-report whitelist above. Same type, same rendering.
const JAM_REPORT_TYPE = "Traffic Jam";
// Reports the server invents itself are attributed to this pseudo-device. It is
// deliberately NOT a real deviceId: no points are awarded for auto reports, and
// nothing should create a gamification profile for it.
const AUTO_REPORT_DEVICE_ID = "system";
// A driver under this speed, but still moving, is treated as congested.
const CONGESTION_SPEED_MS = Number(process.env.CONGESTION_SPEED_KMH || 15) / 3.6;
// Lower bound of the congestion band. Below this the vehicle is stopped or the
// signal is drifting, not crawling. 3 km/h also puts the floor above the noise
// a stationary phone produces indoors.
const CONGESTION_MIN_SPEED_MS = Number(process.env.CONGESTION_MIN_SPEED_KMH || 3) / 3.6;
// Fixes looser than this are ignored for jam detection entirely. Indoor and
// Wi-Fi-derived positions are routinely 50-150m and their apparent "movement"
// is pure drift — feeding that to the detector invents jams inside buildings.
// NOTE: this gates ONLY jam detection. The fix is still stored, mapped, and
// sent as telemetry; nothing about the driver's own experience changes.
const CONGESTION_MAX_ACCURACY_M = Number(process.env.CONGESTION_MAX_ACCURACY_M || 30);
// ---- density / cluster rule ----
// One slow driver is an anecdote: a cyclist, a delivery van parking, a phone
// drifting on a windowsill. A jam is a SHARED condition, so we require
// corroboration from independent devices before inventing a report.
const CLUSTER_RADIUS_M = Number(process.env.CLUSTER_RADIUS_M || 200);
// Total congested drivers required within that radius, INCLUDING the one whose
// streak triggered the check. 2 = "you and at least one other".
const CLUSTER_MIN_DRIVERS = Number(process.env.CLUSTER_MIN_DRIVERS || 2);
// How recently another driver must have reported congestion to count toward
// the cluster. Keeps "simultaneously" meaningful — a driver who crawled past
// here a minute ago and has since sped off shouldn't corroborate anything.
const CLUSTER_FRESH_MS = Number(process.env.CLUSTER_FRESH_MS || 15000);
// Consecutive slow pings required to fire.
const CONGESTION_MIN_PINGS = Number(process.env.CONGESTION_MIN_PINGS || 3);
// Optional wall-clock floor on the streak, OFF by default. At a ~2 s ping
// interval three pings is only ~6 s, which a red light easily satisfies. Set
// this to e.g. 30000 in the field to require a sustained slowdown instead.
const CONGESTION_MIN_SPAN_MS = Number(process.env.CONGESTION_MIN_SPAN_MS || 0);
// Deduplication window: don't invent a second jam within this radius/time.
const CONGESTION_DEDUP_RADIUS_M = Number(process.env.CONGESTION_DEDUP_RADIUS_M || 500);
const CONGESTION_DEDUP_MS = Number(process.env.CONGESTION_DEDUP_MS || 15 * 60 * 1000);

// ---------- social live map (Phase 24) ----------
// Radius within which other drivers are considered "nearby" and shared.
const LIVE_RADIUS_M = Number(process.env.LIVE_RADIUS_M || 5000);
// How often the registry is swept and nearby_drivers fanned out. 3s is a
// compromise: fast enough that markers feel live, slow enough that the O(n·k)
// scan stays trivial and we aren't sending a frame per telemetry ping.
const LIVE_BROADCAST_MS = Number(process.env.LIVE_BROADCAST_MS || 3000);
// A driver with no ping for this long is considered gone and dropped.
const DRIVER_TTL_MS = Number(process.env.DRIVER_TTL_MS || 20000);
// Hard cap per frame. In a dense city 5 km could contain thousands of drivers;
// sending them all would bloat the frame and the client can't render them
// meaningfully anyway. Nearest-first, so the cap trims the least relevant.
const MAX_NEARBY_DRIVERS = Number(process.env.MAX_NEARBY_DRIVERS || 50);
// Re-read a driver's rank from Mongo at most this often (ranks change slowly).
const RANK_REFRESH_MS = Number(process.env.RANK_REFRESH_MS || 5 * 60 * 1000);

// ---------- saved places (Phase 25) ----------
// HOME and WORK are singletons: saving one replaces the existing entry rather
// than appending a duplicate. Everything else is an ordinary favourite.
const SINGLETON_LABELS = new Set(["Home", "Work"]);
// Upper bound on the array so a client bug (or a bored user) can't grow a
// document without limit. Mongo's own 16MB doc cap is far away, but an
// unbounded array would still bloat every profile read.
const MAX_SAVED_PLACES = Number(process.env.MAX_SAVED_PLACES || 50);
const MAX_LABEL_LEN = 60;
const MAX_ADDRESS_LEN = 200;

// ---------- social interactions (Phase 26) ----------
// Honks and likes between drivers who can see each other on the live map.
const INTERACTION_TYPES = new Set(["honk", "like"]);
// Per-sender cooldown: one interaction every 10s, whoever it's aimed at.
const INTERACTION_COOLDOWN_MS = Number(process.env.INTERACTION_COOLDOWN_MS || 10000);
// Per-PAIR cooldown. The sender cooldown alone still lets one driver drip-feed
// a target ~6 likes a minute; this caps how often the same pair can interact,
// which is what actually stops point farming between two colluding devices.
const INTERACTION_PAIR_COOLDOWN_MS = Number(
  process.env.INTERACTION_PAIR_COOLDOWN_MS || 5 * 60 * 1000
);
// Points awarded to the RECIPIENT of a like. Senders get nothing, so there's no
// incentive to spray likes.
const POINTS_PER_LIKE = Number(process.env.POINTS_PER_LIKE || 1);

// ---------- gamification (Phase 22) ----------
// Rank ladder, lowest first. `minPoints` is inclusive, so the bands are
// 0-50 New Driver / 51-200 Road Knight / 201+ Navigation Master. (The spec's
// "51-200" and "200+" overlap at exactly 200; resolved in favour of the lower
// band, so 200 is still a Road Knight and promotion happens at 201.)
const RANKS = [
  { minPoints: 0, name: "New Driver" },
  { minPoints: 51, name: "Road Knight" },
  { minPoints: 201, name: "Navigation Master" },
];
const DEFAULT_RANK = RANKS[0].name;
const POINTS_PER_REPORT = Number(process.env.POINTS_PER_REPORT || 10);
const POINTS_PER_KM = Number(process.env.POINTS_PER_KM || 1);
// Distance is accumulated in memory per connection and flushed in batches:
// writing to Mongo on every ~2 s ping would triple the write load for no gain.
// A flush every 250 m keeps the profile near-live without the churn.
const DISTANCE_FLUSH_KM = Number(process.env.DISTANCE_FLUSH_KM || 0.25);
// Safety valve: if Mongo is down for a long drive the unflushed remainder keeps
// growing. Past this we stop accumulating rather than bank an absurd lump sum.
const MAX_PENDING_KM = Number(process.env.MAX_PENDING_KM || 100);
// A single ping step longer than this is treated as noise, not travel. The
// teleport guard already rejects physically impossible jumps; this catches the
// merely implausible (e.g. a coarse first fix landing far from the last one).
const MAX_STEP_KM = Number(process.env.MAX_STEP_KM || 2);
// Category POI search via Overpass (Phase 17). Separate endpoint from Nominatim
// with its own rate policy, so it gets its own gate (see overpassSlot). Public
// instance is heavily shared — keep the radius modest and the spacing generous.
const OVERPASS_URL = process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter";
const OVERPASS_MIN_GAP_MS = Number(process.env.OVERPASS_MIN_GAP_MS || 1500);
const OVERPASS_RADIUS_M = Number(process.env.OVERPASS_RADIUS_M || 3000);
const OVERPASS_TIMEOUT_S = 20;
// How long to stop calling Overpass after it rate-limits or errors.
const OVERPASS_COOLDOWN_MS = Number(process.env.OVERPASS_COOLDOWN_MS || 3 * 60 * 1000);
// Free-text terms used when falling back to Nominatim for category search.
// Nominatim has no tag filter, so these are the closest natural-language
// equivalents of the Overpass tag sets above.
const CATEGORY_FALLBACK_TERMS = {
  food: "restaurant",
  gas: "fuel station",
  emergency: "hospital",
};

// ---------- traffic signals along the route (Phase 28) ----------
// Signals are fetched AFTER the route is delivered and pushed as a separate
// frame. Overpass can take many seconds on the public instance, and making a
// driver wait for decoration before they can start navigating would be a bad
// trade. The client renders them when they land.
const SIGNALS_BUFFER_M = Number(process.env.SIGNALS_BUFFER_M || 40);
// The route is downsampled to roughly one probe every this many metres before
// building the `around` clause. A city route has thousands of vertices; sending
// all of them would produce a megabyte-long query that Overpass will reject.
const SIGNALS_SAMPLE_M = Number(process.env.SIGNALS_SAMPLE_M || 250);
// Hard cap on probe points, so a cross-country route can't build a query that
// times out. Beyond this the sampling stride is widened instead.
const SIGNALS_MAX_PROBES = Number(process.env.SIGNALS_MAX_PROBES || 120);
const SIGNALS_MAX_RESULTS = Number(process.env.SIGNALS_MAX_RESULTS || 250);
// Cache by route slug/id so a reroute over the same road doesn't re-query.
const SIGNALS_CACHE_MAX = 40;

// ---------- lane counts along the route (Phase 32) ----------
// Corridor half-width when matching route points to OSM ways. Tighter than the
// signal buffer: we want the road we're ON, not the service road beside it.
const LANES_MATCH_M = Number(process.env.LANES_MATCH_M || 25);
// ---- Signal clustering + synthesis (Phase 34) --------------------------------
// Overpass returns a traffic_signals node per STOP LINE, so a normal four-way
// junction yields 4-8 nodes a few metres apart. Rendered raw they pile into an
// unreadable blob of overlapping icons. Anything inside this radius is one
// intersection and collapses to a single centroid.
const SIGNAL_CLUSTER_M = Number(process.env.SIGNAL_CLUSTER_M || 30);
// Synthesiser: OSM traffic-signal tagging is wildly incomplete outside major
// cities, and a junction with no tag is indistinguishable from a junction with
// no light. Rather than leave a major urban intersection blank we INFER one.
//
// Phase 36 brute force. Phase 35 had already loosened the maneuver gate to
// "any turn onto any real street" and STILL produced zero lights in Tiberias.
// The gate was never the problem: the road-evidence lookup behind it was.
// Every candidate had to find a corridor probe within SIGNAL_SYNTH_MATCH_M,
// and those probes come from fetchRouteCorridor(), which returns
// EMPTY_CORRIDOR the moment the Overpass breaker opens. No probes -> no
// nearest match -> every maneuver rejected. Inference was silently coupled to
// Overpass uptime, so it died at exactly the same moment real signals did.
//
// The synthesiser now reads maneuvers ONLY. No probes, no lane samples, no
// road class, no Overpass. Every junction-like maneuver gets a light. The
// honest-labelling contract from Phase 35 is unchanged and is what makes the
// density defensible: inferred:true -> dimmer icon + "רמזור משוער".
//
// SIGNAL_SYNTH_EXCLUDED / SIGNAL_SYNTH_MATCH_M are deliberately gone — they
// were the Overpass coupling. Removing the constants keeps a future reader
// from wiring the dependency back in by accident.

// Inferred-vs-inferred spacing. OSRM emits two steps at one physical junction
// routinely ("roundabout" then "exit roundabout" ~4m apart), which at 80° pitch
// z-fight into one smeared icon.
const SIGNAL_SYNTH_STACK_M = Number(process.env.SIGNAL_SYNTH_STACK_M || 12);
// A maneuver this close to an EXISTING signal is already covered — don't
// double up. 40m (was 60): distinct junctions 40-60m apart — common in the
// old-town grid — now EACH get a light, while anything under the 30m cluster
// radius still reads as a single junction. Kept at 40 deliberately: a clustered
// OSM junction centroid can sit 20-30m from the maneuver point, so dropping
// this to the 12m stacking radius would render a dim inferred twin beside a
// real light at the same junction.
const SIGNAL_SYNTH_DEDUP_M = Number(process.env.SIGNAL_SYNTH_DEDUP_M || 40);
// Roundabouts. The Phase 34 comment asserted they are "by definition
// unsignalised" — true of most Israeli roundabouts, but OSRM also tags plenty
// of ordinary signalised junction entries as roundabout-family with modifier
// "straight", and excluding the whole family dropped those too. Included by
// default for the density pass; set 0 to restore the Phase 34 behaviour.
// PHASE 55: roundabouts are excluded again, reverting the Phase 36 decision.
// The original Phase 34 note here was right — a roundabout is by definition an
// unsignalised junction — and Phase 36 overrode it only to maximise density
// while proving the render pipeline. Field testing put countdown cards on the
// roundabout at Kikar Jabotinsky, where there are no lights to count down.
const SIGNAL_SYNTH_ROUNDABOUTS =
  String(process.env.SIGNAL_SYNTH_ROUNDABOUTS ?? "0") !== "0";

// PHASE 55: inferred lights are OFF by default.
//
// Phase 36 made this brute-force ON PURPOSE, at a point where the goal was to
// prove that the rendering pipeline worked at all — "flood the map and see
// something appear". That job is long done, and the cost has come due: a light
// at every maneuver means countdown cards at junctions that have no signals,
// which is not a cosmetic problem. A driver who learns that the red/green
// counter is sometimes fiction stops trusting it at the junctions where it is
// real, and the honest `inferred: true` label does not undo that — a dimmer
// icon still asserts a light exists.
//
// With this off, a signal is drawn only where OSM actually tagged
// `highway=traffic_signals`. That means FEWER lights, including at real
// signalised junctions nobody has mapped yet. That is the correct trade: a
// missing light is a gap in the data, a fabricated one is a false statement.
// Set SIGNAL_SYNTH_ENABLED=1 to restore inference for experiments.
const SIGNAL_SYNTH_ENABLED = String(process.env.SIGNAL_SYNTH_ENABLED ?? "0") !== "0";
// Sanity ceiling per route. In-city routes land far below this; it exists so a
// pathological cross-country route can't push a four-figure signal array into
// one frame. 0 = unlimited.
const SIGNAL_SYNTH_MAX = Number(process.env.SIGNAL_SYNTH_MAX || 400);
// Fallback lane counts PER DIRECTION when a way carries no usable `lanes` tag.
// These are direction counts already, so they're used as-is — no halving.
// Conservative on purpose: over-stating capacity is the failure that misleads a
// driver, so where a class is ambiguous the lower figure wins.
const LANES_BY_HIGHWAY = {
  motorway: 3,
  trunk: 2,
  primary: 2,
  secondary: 2,
  tertiary: 1,
  unclassified: 1,
  residential: 1,
  living_street: 1,
  service: 1,
  track: 1,
  road: 1,
  // Slip roads and ramps are virtually always single-lane.
  motorway_link: 1,
  trunk_link: 1,
  primary_link: 1,
  secondary_link: 1,
  tertiary_link: 1,
};
const LANES_DEFAULT = 1;
const LANES_MAX = 6;
// Each category maps to an OSM tag regex. The chip labels (Hebrew) live on the
// client; the wire value is the stable English key checked here.
const CATEGORY_FILTERS = {
  food: '["amenity"~"^(restaurant|fast_food|cafe|food_court|pub|bar|ice_cream)$"]',
  gas: '["amenity"="fuel"]',
  emergency: '["amenity"~"^(hospital|clinic|doctors|pharmacy|police)$"]',
  // Phase 70 additions.
  parking: '["amenity"~"^(parking|parking_entrance)$"]',
  charging: '["amenity"="charging_station"]',
  atm: '["amenity"~"^(atm|bank)$"]',
  shop: '["shop"~"^(supermarket|convenience|mall|department_store)$"]',
  hotel: '["tourism"~"^(hotel|hostel|guest_house|motel)$"]',
};

/**
 * Free text that means "find me a category near here", not "find me a place
 * called this".
 *
 * PHASE 70 — the actual POI problem. Typing "מסעדות" went to Nominatim as a
 * free-text geocode, which searches PLACE NAMES globally: it returns a street
 * called Restaurant in Belgium before it returns dinner. Nominatim is a
 * geocoder, and a geocoder is the wrong tool for "what is near me".
 *
 * The Overpass category search already in this file IS the right tool — it was
 * simply only reachable by tapping a chip. Recognising the words routes typed
 * queries to it too. Hebrew first, since that is what gets typed here; the
 * English is for the keyboard-layout cases.
 */
const CATEGORY_LEXICON = {
  food: ["מסעדה", "מסעדות", "אוכל", "מזון", "קפה", "בית קפה", "פיצה", "המבורגר", "restaurant", "restaurants", "food", "cafe", "coffee", "pizza"],
  gas: ["דלק", "תחנת דלק", "תחנות דלק", "תדלוק", "בנזין", "סולר", "gas", "petrol", "fuel", "gas station"],
  parking: ["חניה", "חנייה", "חניון", "חניונים", "parking", "car park"],
  charging: ["טעינה", "עמדת טעינה", "עמדות טעינה", "מטען", "charging", "charger", "ev"],
  atm: ["כספומט", "כספומטים", "בנק", "atm", "bank", "cash"],
  shop: ["סופר", "סופרמרקט", "מכולת", "קניון", "חנות", "supermarket", "grocery", "mall", "shop"],
  hotel: ["מלון", "מלונות", "צימר", "אכסניה", "hotel", "hostel", "motel"],
  emergency: ["בית חולים", "חולים", "מרפאה", "רופא", "בית מרקחת", "מרקחת", "משטרה", "חירום", "hospital", "clinic", "pharmacy", "police", "emergency"],
};

/**
 * Which category a free-text query means, or null for a real place search.
 *
 * Exact match on the normalised string only — no substring matching. "רחוב
 * המסעדות" is a street name and must stay a geocode; matching loosely would
 * hijack every address containing a common noun.
 */
function categoryForQuery(q) {
  const norm = String(q || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!norm) return null;
  for (const [cat, words] of Object.entries(CATEGORY_LEXICON)) {
    if (words.some((w) => w.toLowerCase() === norm)) return cat;
  }
  return null;
}

// ---------- models ----------
// GeoJSON axis order is [lon, lat] — 2dsphere requires it.
const pingSchema = new mongoose.Schema({
  deviceId: String,
  loc: {
    type: { type: String, enum: ["Point"], default: "Point" },
    coordinates: { type: [Number], required: true }, // [lon, lat]
  },
  speed: Number,
  heading: Number,
  accuracy: Number,
  onRoute: Boolean,
  distanceM: Number,
  progressM: Number,
  routeSlug: String,
  ts: { type: Date, default: Date.now },
});
pingSchema.index({ loc: "2dsphere" });
pingSchema.index({ ts: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 7 });
const Ping = mongoose.model("Ping", pingSchema, "location_pings");

// Traffic reports (Phase 15). Same conventions as pings: [lon,lat] Points,
// 2dsphere for future "reports near me" queries, and a TTL so stale reports
// self-expire — a police sighting from yesterday is noise, not signal.
const reportSchema = new mongoose.Schema({
  deviceId: String,
  reportType: String, // one of REPORT_TYPES
  loc: {
    type: { type: String, enum: ["Point"], default: "Point" },
    coordinates: { type: [Number], required: true }, // [lon, lat]
  },
  ts: { type: Date, default: Date.now },
});
reportSchema.index({ loc: "2dsphere" });
reportSchema.index({ ts: 1 }, { expireAfterSeconds: 60 * 60 }); // reports live 1 hour
const Report = mongoose.model("Report", reportSchema, "traffic_reports");

// Search history (Phase 20). Persists a user's destination choices so the
// idle-shell "recent searches" list is real, not placeholder. Keyed by
// deviceId; the compound index (deviceId, ts desc) makes "latest N for this
// device" a covered, cheap query. A 90-day TTL keeps the collection bounded
// without the user ever managing it. Like everything else here, writes are
// fire-and-forget and reads are guarded so Mongo being down never breaks a
// client (see mongoReady()).
const searchHistorySchema = new mongoose.Schema({
  deviceId: { type: String, index: true },
  name: String, // the destination label shown in the list
  lon: Number,
  lat: Number,
  ts: { type: Date, default: Date.now },
});
searchHistorySchema.index({ deviceId: 1, ts: -1 }); // "recent for this device"
searchHistorySchema.index({ ts: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 }); // 90-day cap
const SearchHistory = mongoose.model("SearchHistory", searchHistorySchema, "search_history");

// User profile / gamification (Phase 22). One doc per deviceId, created lazily
// on the first point award — there's no signup step, so the first km driven or
// report filed brings the profile into existence. Every mutation is a single
// atomic $inc rather than read-modify-write, so concurrent sockets for the same
// device can't clobber each other's totals. `rank` is denormalised from points
// so a profile read is one lookup with no recomputation.
// A saved destination (Phase 25). `_id: false` + our own placeId keeps the wire
// contract plain JSON — no ObjectId serialisation for the client to unwrap.
// HOME and WORK are singletons enforced on write; anything else is a favourite
// and may repeat, so deletion is always by placeId.
const savedPlaceSchema = new mongoose.Schema(
  {
    placeId: { type: String, required: true },
    label: { type: String, required: true },
    address: { type: String, default: "" },
    lat: { type: Number, required: true },
    lon: { type: Number, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, unique: true, index: true },
  points: { type: Number, default: 0 },
  totalDistanceKm: { type: Number, default: 0 },
  rank: { type: String, default: DEFAULT_RANK },
  savedPlaces: { type: [savedPlaceSchema], default: [] },
  updatedAt: { type: Date, default: Date.now },
});
const User = mongoose.model("User", userSchema, "users");

// Mongo is OPTIONAL everywhere. Writes are fire-and-forget (.catch and move on),
// but request/response reads (recent searches) must not hang or throw when the
// DB is down — so guard them: only query when the connection is actually up.
// readyState === 1 means connected. Returns false while connecting/disconnected.
function mongoReady() {
  return mongoose.connection.readyState === 1;
}

/**
 * Run a database operation, or give up instantly and return `fallback`.
 *
 * PHASE 57. Three layers, because each catches a different failure:
 *   1. readyState — Mongo is known to be down; don't even try.
 *   2. try/catch  — it was up a moment ago and isn't now, or the query threw.
 *   3. bufferCommands:false (set at the top of this file) — the query can no
 *      longer sit in a queue for 10s before reaching either of the above.
 *
 * Every caller gets a usable value instead of a rejected promise, so a missing
 * database degrades features rather than breaking requests. Logging is rate
 * limited: without that, a 2s ping stream with Mongo down produces a warning
 * every 2s forever, which buries anything else in the log.
 */
let lastDbWarnAt = 0;
function warnDbOnce(label, msg) {
  const now = Date.now();
  if (now - lastDbWarnAt < 30000) return;
  lastDbWarnAt = now;
  console.warn(`[db] ${label} skipped — ${msg} (further notices suppressed 30s)`);
}

async function withDb(label, fallback, fn) {
  if (!mongoReady()) {
    warnDbOnce(label, "not connected");
    return fallback;
  }
  try {
    return await fn();
  } catch (err) {
    warnDbOnce(label, err?.message || String(err));
    return fallback;
  }
}

// ---------- gamification helpers (Phase 22) ----------
// Every one of these is a no-op when Mongo is down: gamification is a nicety,
// never a reason for a ping or a report to fail. They return null instead of
// throwing, and all callers treat them as fire-and-forget.

// Highest band whose threshold the score has reached.
function rankForPoints(points) {
  let name = DEFAULT_RANK;
  for (const band of RANKS) if (points >= band.minPoints) name = band.name;
  return name;
}

// Add points and re-evaluate rank. Upsert means the profile is created on
// first award. Returns the updated doc, or null if unavailable.
async function awardPoints(deviceId, points, reason) {
  if (!deviceId || !mongoReady() || !Number.isFinite(points) || points <= 0) return null;
  try {
    const doc = await User.findOneAndUpdate(
      { deviceId },
      {
        $inc: { points },
        $set: { updatedAt: new Date() },
        $setOnInsert: { totalDistanceKm: 0 },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    if (!doc) return null;
    const nextRank = rankForPoints(doc.points);
    if (nextRank !== doc.rank) {
      await User.updateOne({ deviceId }, { $set: { rank: nextRank } });
      doc.rank = nextRank;
      console.log(`[rank] ${deviceId} promoted to "${nextRank}" (${doc.points} pts)`);
    }
    console.log(`[points] ${deviceId} +${points} (${reason}) -> ${doc.points}`);
    return doc;
  } catch (e) {
    // Includes the E11000 race where two sockets upsert the same new device at
    // once. One increment is lost; not worth a retry loop for a points counter.
    console.warn(`[points] award skipped for ${deviceId}:`, e.message);
    return null;
  }
}

// Bank travelled distance and pay out POINTS_PER_KM for each whole kilometre
// crossed. The $inc returns the new total, so the boundary check is done
// against authoritative data rather than a local guess — meaning a remainder
// carried across restarts or devices still counts toward the next whole km.
async function addDistanceKm(deviceId, km) {
  if (!deviceId || !mongoReady() || !Number.isFinite(km) || km <= 0) return null;
  try {
    const doc = await User.findOneAndUpdate(
      { deviceId },
      {
        $inc: { totalDistanceKm: km },
        $set: { updatedAt: new Date() },
        $setOnInsert: { points: 0, rank: DEFAULT_RANK },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    if (!doc) return null;
    const after = doc.totalDistanceKm;
    const before = after - km;
    const wholeKm = Math.floor(after) - Math.floor(before);
    if (wholeKm > 0) await awardPoints(deviceId, wholeKm * POINTS_PER_KM, `${wholeKm} km`);
    return doc;
  } catch (e) {
    console.warn(`[distance] not banked for ${deviceId}:`, e.message);
    return null;
  }
}

// Replay-on-connect store (Phase 18). A new client should instantly see active
// road hazards, like a real nav app. We keep recent reports IN MEMORY rather
// than querying Mongo on every connect, because the whole architecture treats
// Mongo as optional (pings/reports are fire-and-forget; the socket must never
// hang or die with the DB). Mongo's TTL index is the durable cleanup; this
// window is the fast, always-available replay source. Same 60-min horizon as
// the TTL so the two agree on what "active" means.
const REPORT_TTL_MS = Number(process.env.REPORT_TTL_MS || 60 * 60 * 1000);
// ---- Crowd validation (Phase 34) --------------------------------------------
// A report is only as good as its freshness: police move on, a hazard gets
// cleared, and a stale pin erodes trust in every other pin on the map. Drivers
// passing the spot vote "still there?" and the crowd retires it.
// Net score at or below this removes the report for everyone.
const REPORT_RETIRE_SCORE = Number(process.env.REPORT_RETIRE_SCORE || -2);
// One vote per device per report — a single client cannot brigade a report
// away, which is the obvious abuse of an unauthenticated endpoint.
const reportVotes = new Map(); // reportId -> { score, voters:Set<deviceId> }
// V2X proximity alerts (Phase 21): warn a driver when they approach an active
// report. Thresholds are env-tunable. The per-device scan throttle keeps a
// burst of fast telemetry from re-scanning every ping; the re-alert cooldown
// stops the same hazard nagging the same driver repeatedly.
const PROXIMITY_RADIUS_M = Number(process.env.PROXIMITY_RADIUS_M || 500);
const PROXIMITY_SCAN_MIN_GAP_MS = Number(process.env.PROXIMITY_SCAN_MIN_GAP_MS || 4000);
const PROXIMITY_REALERT_MS = Number(process.env.PROXIMITY_REALERT_MS || 15 * 60 * 1000);
const recentReports = []; // broadcast frames, oldest-first: {type,id,reportType,location,deviceId,ts}

// Drop anything older than the TTL. Called on write and before every replay,
// so stale hazards never linger in memory or reach a new client.
function pruneRecentReports(now = Date.now()) {
  const cutoff = now - REPORT_TTL_MS;
  let drop = 0;
  while (drop < recentReports.length && recentReports[drop].ts < cutoff) drop++;
  if (drop) recentReports.splice(0, drop); // oldest-first, so expired ones are a prefix
}

// Proximity-alert dedup: remembers when a device was last alerted about a
// report, keyed "deviceId|reportId", so a hazard doesn't nag on every ping.
// Entries self-expire past the re-alert window; the map is swept opportunistically
// on each scan so it can't grow unbounded as reports/devices churn.
const proximityAlerts = new Map(); // "deviceId|reportId" -> last-alert ms

// ---------- automatic congestion detection (Phase 23) ----------
// Dedup index of auto-generated jams: {lon, lat, ts}, newest last. Kept
// separate from recentReports because the two have different lifetimes — a jam
// must suppress duplicates for CONGESTION_DEDUP_MS even after its broadcast
// frame has aged out of the replay window, and manual reports must never
// suppress an auto one.
const autoJams = [];

// Drop dedup entries past the window. Same prefix-splice trick as
// pruneRecentReports: the array is append-only in timestamp order, so expired
// entries are always a contiguous prefix and this is O(expired), not O(n).
function pruneAutoJams(now = Date.now()) {
  const cutoff = now - CONGESTION_DEDUP_MS;
  let drop = 0;
  while (drop < autoJams.length && autoJams[drop].ts < cutoff) drop++;
  if (drop) autoJams.splice(0, drop);
}

// Is there already an auto jam within the dedup radius? Bounding-box reject
// first, haversine only for survivors — the same two-stage filter the proximity
// scanner uses. The list is bounded by the dedup window, so this stays tiny.
function hasNearbyAutoJam(lon, lat, now = Date.now()) {
  pruneAutoJams(now);
  if (!autoJams.length) return false;
  const latPad = CONGESTION_DEDUP_RADIUS_M * DEG_LAT_PER_M;
  const cosLat = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  const lonPad = latPad / cosLat;
  for (const j of autoJams) {
    if (Math.abs(j.lat - lat) > latPad || Math.abs(j.lon - lon) > lonPad) continue;
    if (haversineM(lat, lon, j.lat, j.lon) <= CONGESTION_DEDUP_RADIUS_M) return true;
  }
  return false;
}

// ---------- saved places helpers (Phase 25) ----------
// Same contract as the gamification helpers above: never throw, never hang,
// and no-op cleanly when Mongo is down. Callers always get an array back (empty
// on failure) so the UI can render a consistent empty state either way.

// Trim and bound the client-supplied strings; reject impossible coordinates.
// Returns a ready-to-store place, or null if the payload is unusable.
function normalizeSavedPlace(raw, now = Date.now()) {
  const label = String(raw?.label ?? "").trim().slice(0, MAX_LABEL_LEN);
  const address = String(raw?.address ?? "").trim().slice(0, MAX_ADDRESS_LEN);
  const lat = Number(raw?.lat);
  const lon = Number(raw?.lon);
  if (!label) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return {
    placeId: `pl-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    label,
    address,
    lat,
    lon,
    createdAt: new Date(now),
  };
}

// Strip Mongo internals so the client gets exactly the shape it expects.
function serializeSavedPlaces(places) {
  if (!Array.isArray(places)) return [];
  return places.map((p) => ({
    placeId: p.placeId,
    label: p.label,
    address: p.address || "",
    lat: p.lat,
    lon: p.lon,
  }));
}

async function readSavedPlaces(deviceId) {
  if (!deviceId || !mongoReady()) return [];
  try {
    const doc = await User.findOne({ deviceId }).select("savedPlaces").lean();
    return serializeSavedPlaces(doc?.savedPlaces);
  } catch (e) {
    console.warn(`[places] read failed for ${deviceId}:`, e.message);
    return [];
  }
}

// Upsert a place. Home/Work replace any existing entry with that label; every
// other label appends. $slice caps the array from the OLDEST end, so the most
// recent favourites survive once the cap is hit.
async function saveUserPlace(deviceId, raw) {
  if (!deviceId || !mongoReady()) return { ok: false, reason: "unavailable", places: [] };
  const place = normalizeSavedPlace(raw);
  if (!place) return { ok: false, reason: "invalid", places: [] };
  try {
    if (SINGLETON_LABELS.has(place.label)) {
      // Two writes rather than one pipeline update: broader Mongo/Atlas tier
      // compatibility, and the window between them is harmless here (worst case
      // a duplicate Home exists for microseconds, on a single user's own doc).
      await User.updateOne(
        { deviceId },
        { $pull: { savedPlaces: { label: place.label } } },
        { upsert: true }
      );
    }
    const doc = await User.findOneAndUpdate(
      { deviceId },
      {
        $push: { savedPlaces: { $each: [place], $slice: -MAX_SAVED_PLACES } },
        $set: { updatedAt: new Date() },
        $setOnInsert: { points: 0, totalDistanceKm: 0, rank: DEFAULT_RANK },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    )
      .select("savedPlaces")
      .lean();
    console.log(`[places] ${deviceId} saved "${place.label}"`);
    return { ok: true, place, places: serializeSavedPlaces(doc?.savedPlaces) };
  } catch (e) {
    console.warn(`[places] save failed for ${deviceId}:`, e.message);
    return { ok: false, reason: "error", places: [] };
  }
}

// Delete by placeId (preferred) or by label — the latter lets a client clear
// "Home" without knowing its generated id.
async function deleteUserPlace(deviceId, { placeId, label }) {
  if (!deviceId || !mongoReady()) return { ok: false, reason: "unavailable", places: [] };
  const match = placeId
    ? { placeId: String(placeId) }
    : label
      ? { label: String(label).trim().slice(0, MAX_LABEL_LEN) }
      : null;
  if (!match) return { ok: false, reason: "invalid", places: [] };
  try {
    const doc = await User.findOneAndUpdate(
      { deviceId },
      { $pull: { savedPlaces: match }, $set: { updatedAt: new Date() } },
      { new: true }
    )
      .select("savedPlaces")
      .lean();
    console.log(`[places] ${deviceId} deleted ${JSON.stringify(match)}`);
    return { ok: true, places: serializeSavedPlaces(doc?.savedPlaces) };
  } catch (e) {
    console.warn(`[places] delete failed for ${deviceId}:`, e.message);
    return { ok: false, reason: "error", places: [] };
  }
}

// ---------- social live map: active driver registry (Phase 24) ----------// deviceId -> {deviceId, lon, lat, heading, speed, rank, rankAt, lastSeen, ws}
// Keyed by device (not socket) so a reconnect reuses the same identity instead
// of spawning a ghost. `ws` is the socket to deliver that driver's frame on.
const activeDrivers = new Map();

// Per-PAIR interaction cooldown (Phase 26): "sender>target" -> last ms.
// Bounded by pruning on write rather than a timer — the map only grows when
// people actually interact, and stale pairs are swept opportunistically.
const interactionPairs = new Map();

function pruneInteractionPairs(now) {
  if (interactionPairs.size < 500) return; // cheap: only sweep once it matters
  for (const [k, ts] of interactionPairs) {
    if (now - ts > INTERACTION_PAIR_COOLDOWN_MS) interactionPairs.delete(k);
  }
}

// Upsert from a telemetry ping. O(1). Rank is cached on the entry and refreshed
// lazily — never awaited, so a Mongo hiccup can't slow the telemetry path.
function touchDriver({ deviceId, lon, lat, heading, speed, accuracy, ws, now }) {
  let d = activeDrivers.get(deviceId);
  if (!d) {
    d = { deviceId, rank: DEFAULT_RANK, rankAt: 0, congestedAt: 0 };
    activeDrivers.set(deviceId, d);
  }
  d.lon = lon;
  d.lat = lat;
  // heading is degrees clockwise from north; -1 (or null) means "unknown",
  // which the client renders as a plain dot rather than a rotated arrow.
  d.heading = Number.isFinite(heading) && heading >= 0 ? heading : -1;
  d.speed = Number.isFinite(speed) && speed >= 0 ? speed : -1;
  d.accuracy = Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : -1;
  d.lastSeen = now;
  d.ws = ws;

  // Phase 27 density rule: mark whether THIS driver currently looks congested,
  // so any other driver's streak can count them as corroboration without
  // re-deriving it. Stamped with a time so staleness can be judged later.
  if (isCongestedSample(d.speed, d.accuracy)) d.congestedAt = now;
  else d.congestedAt = 0;

  // Lazily attach the gamification rank so other drivers can see it. Skipped
  // entirely when Mongo is down — everyone just shows as the default rank.
  if (mongoReady() && now - d.rankAt > RANK_REFRESH_MS) {
    d.rankAt = now; // set first, so a slow query can't queue duplicates
    User.findOne({ deviceId })
      .select("rank")
      .lean()
      .then((doc) => {
        if (doc?.rank) d.rank = doc.rank;
      })
      .catch(() => {
        /* rank is cosmetic; keep the cached value */
      });
  }
  return d;
}

// Drop drivers who stopped pinging. Called on every broadcast tick.
function pruneDrivers(now = Date.now()) {
  for (const [id, d] of activeDrivers) {
    if (now - d.lastSeen > DRIVER_TTL_MS) activeDrivers.delete(id);
  }
}

// Everyone within LIVE_RADIUS_M of (lat,lon), EXCLUDING selfId. Bounding-box
// reject before the haversine — same two-stage filter as the proximity scanner.
// Sorted nearest-first then capped, so the cap trims the least relevant.
function nearbyDriversFor(selfId, lat, lon) {
  const latPad = LIVE_RADIUS_M * DEG_LAT_PER_M;
  const cosLat = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  const lonPad = latPad / cosLat;
  const out = [];
  for (const d of activeDrivers.values()) {
    if (d.deviceId === selfId) continue; // never send a driver themselves
    if (!Number.isFinite(d.lat) || !Number.isFinite(d.lon)) continue;
    if (Math.abs(d.lat - lat) > latPad || Math.abs(d.lon - lon) > lonPad) continue;
    const distanceM = haversineM(lat, lon, d.lat, d.lon);
    if (distanceM > LIVE_RADIUS_M) continue;
    out.push({
      deviceId: d.deviceId,
      lon: d.lon,
      lat: d.lat,
      heading: d.heading,
      speed: d.speed,
      rank: d.rank,
      distanceM: Math.round(distanceM),
    });
  }
  out.sort((a, b) => a.distanceM - b.distanceM);
  return out.length > MAX_NEARBY_DRIVERS ? out.slice(0, MAX_NEARBY_DRIVERS) : out;
}

// ---------- congestion sampling + density rule (Phase 23 / 27) ----------
// Does a single fix qualify as "crawling in traffic"?
//
// Three gates, all necessary:
//   accuracy  — a loose fix's apparent motion is drift, not travel
//   speed >=  — below the floor the vehicle is stopped, parked, or noise
//   speed <   — above the ceiling traffic is plainly flowing
// Returns false for unknown speed (-1, e.g. iOS) and unknown accuracy, because
// "we don't know" must never be treated as evidence of a jam.
function isCongestedSample(speedMs, accuracyM) {
  if (!Number.isFinite(speedMs) || speedMs < 0) return false;
  if (!Number.isFinite(accuracyM) || accuracyM < 0) return false;
  if (accuracyM > CONGESTION_MAX_ACCURACY_M) return false;
  return speedMs >= CONGESTION_MIN_SPEED_MS && speedMs < CONGESTION_SPEED_MS;
}

// How many DISTINCT, CURRENTLY-CONNECTED devices are congested right now within
// CLUSTER_RADIUS_M of (lat,lon) — counting the trigger driver themselves.
//
// Every gate here exists because of a real false positive:
//
//   unique deviceId  — the registry is keyed by deviceId so duplicates are
//                      already impossible, but the Set makes that a guarantee
//                      of this function rather than an assumption about its
//                      caller, and it's what the count actually reports.
//   live socket      — a driver whose socket has closed but whose entry hasn't
//                      hit the 20s TTL yet is a GHOST. During development every
//                      Metro reload leaves one behind, and if the device id
//                      isn't persisted (AsyncStorage missing) each reload also
//                      arrives under a NEW id — so one person reloading twice
//                      could self-corroborate into a phantom two-car jam.
//   fresh lastSeen   — an entry that stopped pinging is not "currently" doing
//                      anything, whatever its last congestion sample said.
//
// Returns the unique ids so the caller can log exactly who formed the cluster.
function countCongestedCluster(lat, lon, now) {
  const latPad = CLUSTER_RADIUS_M * DEG_LAT_PER_M;
  const cosLat = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  const lonPad = latPad / cosLat;
  const ids = new Set();
  for (const d of activeDrivers.values()) {
    if (!d.deviceId) continue;
    // must be congested, and recently so
    if (!d.congestedAt || now - d.congestedAt > CLUSTER_FRESH_MS) continue;
    // must still be sending telemetry
    if (!d.lastSeen || now - d.lastSeen > CLUSTER_FRESH_MS) continue;
    // must still be connected — excludes reload ghosts
    if (!d.ws || d.ws.readyState !== WebSocket.OPEN) continue;
    if (!Number.isFinite(d.lat) || !Number.isFinite(d.lon)) continue;
    if (Math.abs(d.lat - lat) > latPad || Math.abs(d.lon - lon) > lonPad) continue;
    if (haversineM(lat, lon, d.lat, d.lon) > CLUSTER_RADIUS_M) continue;
    ids.add(d.deviceId);
  }
  return { count: ids.size, members: [...ids].slice(0, 5) };
}

// Single publish path for BOTH manual and auto reports, so an auto jam is
// indistinguishable downstream: same frame shape, same replay window, same
// Mongo write, same fan-out — which is what makes it flow into the existing
// V2X proximity scanner for free (it reads recentReports).
//
// `excludeWs` is the reporter's own socket for manual reports (they already got
// an ack) and null for auto reports, which go to everyone including the driver
// who was stuck — their client dedups by reportId, and knowing the jam ahead is
// confirmed is useful.
function publishReport({ reportType, location, deviceId, excludeWs = null, now = Date.now() }) {
  const report = {
    type: "traffic_report",
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    reportType,
    location,
    deviceId: deviceId ?? null,
    ts: now,
  };
  // persist fire-and-forget (same contract as pings: broadcast never waits on Mongo)
  Report.create({
    deviceId: report.deviceId,
    reportType: report.reportType,
    loc: { type: "Point", coordinates: location },
    ts: new Date(now),
  }).catch((dbErr) => console.warn("report not persisted:", dbErr.message));
  // in-memory replay window (independent of Mongo), pruned by the same TTL
  recentReports.push(report);
  pruneRecentReports(now);
  let fanout = 0;
  for (const client of wss.clients) {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(report));
      fanout++;
    }
  }
  return { report, fanout };
}

// Degrees of latitude per metre (~constant); longitude is scaled by cos(lat).
// Used for a cheap bounding-box reject BEFORE the haversine, so most reports are
// discarded with subtractions instead of a trig call.
const DEG_LAT_PER_M = 1 / 111_320;

// Lightweight spatial scan: which active reports is this driver within radius
// of, that we haven't already alerted them about recently. Reuses haversineM
// (Phase 17) but only after a bounding-box pre-filter rejects far-away reports.
// Pure except for reading recentReports + updating the dedup map.
function proximityAlertsFor(deviceId, lat, lon, now = Date.now()) {
  if (!recentReports.length) return [];
  const latPad = PROXIMITY_RADIUS_M * DEG_LAT_PER_M;
  const cosLat = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  const lonPad = latPad / cosLat; // wider box in longitude near the equator
  const out = [];
  for (const r of recentReports) {
    const loc = r.location; // [lon, lat]
    if (!Array.isArray(loc) || loc.length !== 2) continue;
    // bbox reject: skip the trig entirely if clearly outside the radius box
    if (Math.abs(loc[1] - lat) > latPad || Math.abs(loc[0] - lon) > lonPad) continue;
    const distanceM = haversineM(lat, lon, loc[1], loc[0]);
    if (distanceM > PROXIMITY_RADIUS_M) continue;
    // per-device-per-report re-alert cooldown
    const key = `${deviceId}|${r.id}`;
    const last = proximityAlerts.get(key);
    if (last != null && now - last < PROXIMITY_REALERT_MS) continue;
    proximityAlerts.set(key, now);
    out.push({ reportId: r.id, reportType: r.reportType, distanceMeters: distanceM });
  }
  // opportunistic sweep of expired dedup entries (keeps the map bounded)
  if (proximityAlerts.size > 1000) {
    for (const [k, t] of proximityAlerts) if (now - t >= PROXIMITY_REALERT_MS) proximityAlerts.delete(k);
  }
  return out;
}

const routeSchema = new mongoose.Schema(
  { slug: String, name: String, geometry: Object, buffer: Object, lengthM: Number },
  { collection: "routes" }
);
const Route = mongoose.model("Route", routeSchema);

// ---------- static route (Highway 90 baseline) ----------
let routeDoc = null;
let routeLine = null;

async function loadRoute() {
  // PHASE 57: this is the `routes.findOne()` from the Render log. It was called
  // unguarded — including from the connect .catch(), i.e. at the exact moment
  // the connection was known to have failed — so it buffered for 10s and then
  // reported a timeout that had nothing to do with the route.
  //
  // The baseline Route 90 corridor is the ONLY feature that needs this. Dynamic
  // per-device routes come from OSRM and live in the `dynamicRoutes` Map, so
  // returning early here costs the seeded corridor and nothing else: live
  // tracking, routing, rerouting, lane guidance and the WebSocket all continue.
  routeDoc = await withDb("route load", null, () =>
    Route.findOne({ slug: ROUTE_SLUG }).lean()
  );
  if (!routeDoc) {
    console.warn(`Route '${ROUTE_SLUG}' not seeded — log-only mode. Run extract_route_90.py.`);
    return;
  }
  routeLine = turf.lineString(routeDoc.geometry.coordinates);
  console.log(`Route loaded: ${routeDoc.name} (${(routeDoc.lengthM / 1000).toFixed(2)} km)`);
}

// ---------- dynamic routes (per device, never global) ----------
const dynamicRoutes = new Map();

function rememberDynamicRoute(deviceId, entry) {
  if (!deviceId) return;
  const now = Date.now();
  for (const [k, v] of dynamicRoutes) {
    if (now - v.ts > DYNAMIC_ROUTE_TTL_MS) dynamicRoutes.delete(k);
  }
  if (dynamicRoutes.size > 100) dynamicRoutes.delete(dynamicRoutes.keys().next().value);
  dynamicRoutes.set(deviceId, entry);
}

// ---------- Nominatim gate: serialize calls with a >=1.1s spacing ----------
// A step can declare itself superseded (a newer query replaced it) and skip
// without consuming spacing — checked before AND after the wait, so a burst
// of keystrokes collapses to at most a couple of real geocoder calls.
let nominatimChain = Promise.resolve(0);
function nominatimSlot(stillWanted) {
  const run = nominatimChain.then(async (lastTs) => {
    if (stillWanted && !stillWanted()) return { ts: lastTs, skipped: true };
    const wait = Math.max(0, lastTs + NOMINATIM_MIN_GAP_MS - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    if (stillWanted && !stillWanted()) return { ts: lastTs, skipped: true };
    return { ts: Date.now(), skipped: false };
  });
  nominatimChain = run.then((r) => r.ts).catch(() => Date.now());
  return run;
}

function nominatimParams(query, limit) {
  const p = new URLSearchParams({
    q: query,
    format: "jsonv2",
    limit: String(limit),
    addressdetails: "1",
    "accept-language": NOMINATIM_LANG,
    // Phase 70: extratags carries opening_hours/brand/cuisine, namedetails the
    // local-language name. Both are what make a POI hit look like a business
    // rather than a coordinate.
    extratags: "1",
    namedetails: "1",
  });
  if (SEARCH_VIEWBOX) {
    p.set("viewbox", SEARCH_VIEWBOX);
    p.set("bounded", "0"); // bias toward the box, don't hard-filter
  }
  return p.toString();
}

// ---------- Overpass gate: serialize category-POI calls with >=1.5s spacing ----------
// Separate chain from Nominatim (different endpoint, different rate policy).
// Same serialize-with-spacing discipline so a tap-happy user can't burst the
// shared public instance.
let overpassChain = Promise.resolve(0);

// ---------- Overpass circuit breaker (Phase 29) ----------
// The public Overpass instance rate-limits per IP, and the traffic-signal
// lookup (Phase 28) shares that budget with category search. Signals are
// decoration; category search is something the driver actively asked for — so
// when Overpass starts refusing, signals must yield rather than keep burning
// the quota that search needs.
let overpassCooldownUntil = 0;
function overpassAvailable() {
  return Date.now() >= overpassCooldownUntil;
}
function tripOverpassBreaker(reason, ms = OVERPASS_COOLDOWN_MS) {
  overpassCooldownUntil = Date.now() + ms;
  console.warn(
    `[overpass] backing off ${Math.round(ms / 1000)}s after ${reason} — ` +
      `category search will use the Nominatim fallback, signals are skipped`
  );
}
function overpassSlot() {
  const run = overpassChain.then(async (lastTs) => {
    const wait = Math.max(0, lastTs + OVERPASS_MIN_GAP_MS - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    return Date.now();
  });
  overpassChain = run.catch(() => Date.now());
  return run;
}

// Overpass QL: nodes+ways+relations with the category's tag(s) within radius of
// the point. `out center` resolves a single lat/lon for ways/relations so every
// element has coordinates. nwr = node|way|relation shorthand.
function overpassQuery(filter, lat, lon) {
  return (
    `[out:json][timeout:${OVERPASS_TIMEOUT_S}];` +
    `(` +
    `node${filter}(around:${OVERPASS_RADIUS_M},${lat},${lon});` +
    `way${filter}(around:${OVERPASS_RADIUS_M},${lat},${lon});` +
    `relation${filter}(around:${OVERPASS_RADIUS_M},${lat},${lon});` +
    `);out center tags 30;`
  );
}

// haversine metres between two [lat,lon] points — for sorting POIs by proximity
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

// Parse an Overpass response into clean, minimal, client-ready items. Pure and
// testable: drops unnamed POIs, resolves way/relation centers, sorts by
// distance, caps the list. `detail` is a short human hint from the tags.
function parseOverpassResponse(data, originLat, originLon, limit = 15) {
  if (!data || !Array.isArray(data.elements)) return [];
  const items = [];
  for (const el of data.elements) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    const tags = el.tags || {};
    const name = tags.name || tags["name:he"] || tags["name:en"];
    if (lat == null || lon == null || !name) continue; // need coords + a name to be useful
    const detail =
      tags["addr:street"] ||
      tags.cuisine ||
      tags.brand ||
      tags.operator ||
      tags.amenity ||
      "";
    items.push({
      name,
      detail: String(detail).replace(/_/g, " "),
      lon,
      lat,
      distanceM: haversineM(originLat, originLon, lat, lon),
    });
  }
  items.sort((a, b) => a.distanceM - b.distanceM);
  return items.slice(0, limit);
}

/**
 * Lanes in OUR DIRECTION OF TRAVEL for an OSM way.
 *
 * This is the subtle part, and getting it backwards produces exactly the error
 * we're fixing. OSM's `lanes` counts the carriageway's TOTAL lanes across both
 * directions unless the way is oneway. So `lanes=2` on an ordinary two-way
 * street means ONE lane each way — rendering two would be wrong.
 *
 * Resolution order, most specific first:
 *   1. lanes:forward         — explicit per-direction count, always authoritative
 *   2. lanes + oneway        — the whole count belongs to our direction
 *   3. lanes (bidirectional) — halve it, floor, minimum 1
 *   4. highway class         — inferred default
 *
 * `lanes:backward` is deliberately ignored: the route follows the way's forward
 * direction as OSRM traverses it, and we have no reliable per-segment traversal
 * direction here. Using the forward count (or the halved total) is the safe
 * reading — it never over-states capacity.
 */
/**
 * Does this way carry traffic in ONE direction only?
 *
 * Phase 51: the client needs this, not just lanesForWay. On a oneway way the
 * OSM geometry IS the carriageway centre, so lanes sit symmetrically about it.
 * On a two-way way the geometry is the ROAD centre, and our direction only owns
 * the right-hand half — drawing the forward lanes centred on it puts them
 * astride the centre line and, for a left turn, squarely in oncoming traffic.
 * Exported through the lane samples so the client can offset correctly.
 */
function isOnewayWay(tags) {
  const v = String(tags?.oneway ?? "").trim().toLowerCase();
  // "-1" means oneway against the way's direction — still a single-direction
  // carriageway, which is all the geometry cares about.
  if (v === "yes" || v === "1" || v === "-1" || v === "true") return true;

  // PHASE 55: a roundabout is one-way by definition and OSM therefore does NOT
  // require the oneway tag on it — `junction=roundabout` carries that meaning
  // on its own, and most mappers omit oneway entirely. Reading such a way as
  // two-way pushed the driving line half a carriageway sideways on every
  // roundabout, which is precisely where the corridor was seen leaving its
  // lane. `circular` is the same contract for non-priority circular junctions.
  const j = String(tags?.junction ?? "").trim().toLowerCase();
  return j === "roundabout" || j === "circular";
}

function lanesForWay(tags) {
  if (!tags) return LANES_DEFAULT;
  const num = (v) => {
    const n = parseInt(String(v ?? "").trim(), 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, LANES_MAX) : null;
  };

  const fwd = num(tags["lanes:forward"]);
  if (fwd) return fwd;

  const total = num(tags.lanes);
  const isOneway = isOnewayWay(tags);

  if (total) {
    if (isOneway) return total;
    return Math.max(1, Math.floor(total / 2));
  }

  const inferred = LANES_BY_HIGHWAY[String(tags.highway ?? "").toLowerCase()];
  return inferred ?? LANES_DEFAULT;
}

/**
 * Legal speed limit for a way, in km/h — or null when we genuinely don't know.
 *
 * SAFETY POSTURE. This value is presented to the driver as a regulatory sign,
 * so it must never be a guess. Note the deliberate contrast with lanesForWay()
 * directly above, which happily falls back to LANES_BY_HIGHWAY: a wrong lane
 * count produces slightly wrong geometry, whereas a wrong speed limit tells the
 * driver a falsehood about the law they're subject to. There is therefore NO
 * highway-class fallback here. Unparseable or absent => null => no sign shown.
 *
 * Handled:
 *   "50"          plain number, km/h by OSM convention
 *   "50 km/h"     explicit metric unit
 *   "30 mph"      imperial, converted
 *   "IL:urban"    documented country default — a legal fact, not an inference
 *
 * Deliberately NOT handled (all return null): "none" (no limit), "signals" and
 * "variable" (limit is on a gantry we can't read), "walk" (no numeric legal
 * value), and any country implicit category not in the table below.
 */
const IMPLICIT_MAXSPEED_KMH = {
  // Israel. Built-up areas are 50 and open single carriageway is 80 under the
  // Traffic Regulations; both are settled enough to state as fact.
  "il:urban": 50,
  "il:rural": 80,
  // IL:motorway and IL:trunk are deliberately absent — Israeli motorway limits
  // vary by section (90/100/110) and are signed, so a mapper using the implicit
  // tag there has told us less than they think. Extend this table ONLY with
  // values you have actually verified.
};

function parseMaxspeedKmh(tags) {
  const raw = tags?.maxspeed;
  if (raw == null) return null;
  const v = String(raw).trim().toLowerCase();
  if (!v) return null;

  const plain = /^(\d+(?:\.\d+)?)$/.exec(v);
  if (plain) {
    const n = Math.round(Number(plain[1]));
    return n > 0 && n <= 200 ? n : null;
  }

  const united = /^(\d+(?:\.\d+)?)\s*(km\/h|kmh|kph|mph|knots)$/.exec(v);
  if (united) {
    const n = Number(united[1]);
    const factor = united[2] === "mph" ? 1.609344 : united[2] === "knots" ? 1.852 : 1;
    const kmh = Math.round(n * factor);
    return kmh > 0 && kmh <= 200 ? kmh : null;
  }

  return IMPLICIT_MAXSPEED_KMH[v] ?? null;
}

/** Squared distance from point to segment, in a local metre space. */
function pointSegDistM(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * For every probe point along the route, find the nearest matching OSM way and
 * read its lane count.
 *
 * Matching is done in a local metre projection with a bounding-box reject
 * before any real distance work, so the nested loop stays cheap: this runs once
 * per route, not per ping.
 */
function resolveLaneSamples(probes, ways) {
  const M_PER_DEG_LAT = 111320;
  const out = [];
  for (const [plat, plon] of probes) {
    const mPerDegLon = M_PER_DEG_LAT * Math.cos((plat * Math.PI) / 180);
    const px = plon * mPerDegLon;
    const py = plat * M_PER_DEG_LAT;
    const padDeg = LANES_MATCH_M / M_PER_DEG_LAT;

    let bestDist = Infinity;
    let bestWay = null;
    for (const w of ways) {
      const g = w.geometry;
      if (!Array.isArray(g) || g.length < 2) continue;
      // cheap bbox reject before touching segments
      if (w.minLat - padDeg > plat || w.maxLat + padDeg < plat) continue;
      if (w.minLon - padDeg > plon || w.maxLon + padDeg < plon) continue;
      for (let i = 0; i < g.length - 1; i++) {
        const d = pointSegDistM(
          px,
          py,
          g[i].lon * mPerDegLon,
          g[i].lat * M_PER_DEG_LAT,
          g[i + 1].lon * mPerDegLon,
          g[i + 1].lat * M_PER_DEG_LAT
        );
        if (d < bestDist) {
          bestDist = d;
          bestWay = w;
        }
      }
    }
    if (bestWay && bestDist <= LANES_MATCH_M) {
      out.push({
        lanes: lanesForWay(bestWay.tags),
        highway: String(bestWay.tags?.highway ?? ""),
        // Phase 51: lets the client place the forward carriageway on the
        // correct side of a two-way centreline.
        oneway: isOnewayWay(bestWay.tags),
        // true when the count came from an explicit tag rather than inference
        tagged: !!(bestWay.tags?.lanes || bestWay.tags?.["lanes:forward"]),
        // Phase 44. Free of extra Overpass load: the corridor query already asks
        // for `out tags`, so the maxspeed tag was arriving and being discarded.
        maxspeedKmh: parseMaxspeedKmh(bestWay.tags),
      });
    } else {
      // No way matched — emit a null so the client knows this stretch is
      // unknown rather than silently inventing a lane count for it.
      // No way matched: oneway false is the safer default — assuming a
      // two-way road offsets us onto the right-hand side, which is where a
      // driver actually is. Assuming oneway would straddle the centre line.
      out.push({
        lanes: null,
        highway: "",
        tagged: false,
        maxspeedKmh: null,
        oneway: false,
        surface: null,
      });
    }
  }
  return out;
}

// ---------- traffic signals along a route (Phase 28) ----------
// Walk the route and emit a probe point roughly every SIGNALS_SAMPLE_M metres.
// Overpass `around` takes a coordinate LIST and unions the discs around each,
// which traces the road corridor far more tightly than one huge bbox — a bbox
// around a long route would drag in every signal in the city.
function sampleRouteForSignals(coords) {
  if (!Array.isArray(coords) || coords.length === 0) return [];
  // Widen the stride rather than truncating, so probes stay spread over the
  // WHOLE route instead of covering only the first N kilometres.
  let stride = SIGNALS_SAMPLE_M;
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversineM(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
  }
  if (total / stride > SIGNALS_MAX_PROBES) stride = total / SIGNALS_MAX_PROBES;

  const probes = [[coords[0][1], coords[0][0]]]; // [lat, lon]
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    acc += haversineM(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
    if (acc >= stride) {
      probes.push([coords[i][1], coords[i][0]]);
      acc = 0;
    }
  }
  const last = coords[coords.length - 1];
  probes.push([last[1], last[0]]);
  return probes;
}

// Small LRU-ish cache: reroutes over the same roads are common and the signal
// set barely changes, so re-querying Overpass for them is pure waste.
const signalsCache = new Map();

const EMPTY_CORRIDOR = { signals: [], laneSamples: [], probes: [] };

/**
 * One corridor lookup serving BOTH traffic signals and lane counts.
 *
 * Returns { signals, laneSamples, probes } where laneSamples[i] describes the
 * road at probes[i] — so the client can map a sample back to a position along
 * the route by index.
 */
async function fetchRouteCorridor(coords) {
  // Shares the Overpass quota with category search, which the driver actively
  // asked for. While the breaker is open, yield entirely.
  if (!overpassAvailable()) {
    console.log("[corridor] skipped — Overpass cooling down, search has priority");
    return EMPTY_CORRIDOR;
  }
  const probes = sampleRouteForSignals(coords);
  if (probes.length === 0) return EMPTY_CORRIDOR;

  const key = probes
    .map(([la, lo]) => `${la.toFixed(3)},${lo.toFixed(3)}`)
    .join("|");
  const cached = signalsCache.get(key);
  if (cached) return cached;

  const around = probes.map(([la, lo]) => `${la},${lo}`).join(",");
  // ONE request for both concerns. Overpass is our scarcest resource (it has a
  // circuit breaker for exactly this reason), so fetching lane data as a second
  // query would double the pressure on it for no benefit — the corridor is
  // identical, only the element type differs.
  //   nodes → traffic signals
  //   ways  → the roads themselves, for lane counts
  // `out geom` is needed on the ways so route points can be matched to the
  // correct road; the signal nodes only need their coordinates.
  const q =
    `[out:json][timeout:${OVERPASS_TIMEOUT_S}];` +
    `(` +
    `node["highway"="traffic_signals"](around:${SIGNALS_BUFFER_M},${around});` +
    `way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road)(_link)?$"]` +
    `(around:${LANES_MATCH_M},${around});` +
    `);` +
    `out tags geom ${SIGNALS_MAX_RESULTS};`;

  await overpassSlot(); // share the same 1.5s spacing as category search
  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "TiberiasNavPoC/1.0",
    },
    body: `data=${encodeURIComponent(q)}`,
  });
  if (!res.ok) {
    if (res.status === 429 || res.status === 504 || res.status === 503) {
      tripOverpassBreaker(`HTTP ${res.status} (signals)`);
    }
    throw new Error(`overpass ${res.status}`);
  }
  const data = await res.json();
  const signals = [];
  const ways = [];
  for (const el of data?.elements ?? []) {
    if (el.type === "node" && typeof el.lat === "number" && typeof el.lon === "number") {
      signals.push({ id: String(el.id), lon: el.lon, lat: el.lat });
    } else if (el.type === "way" && Array.isArray(el.geometry) && el.geometry.length >= 2) {
      // Precompute the bbox once so the matcher can reject cheaply.
      let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
      for (const p of el.geometry) {
        if (p.lat < minLat) minLat = p.lat;
        if (p.lat > maxLat) maxLat = p.lat;
        if (p.lon < minLon) minLon = p.lon;
        if (p.lon > maxLon) maxLon = p.lon;
      }
      ways.push({ tags: el.tags || {}, geometry: el.geometry, minLat, maxLat, minLon, maxLon });
    }
  }
  const result = { signals, laneSamples: resolveLaneSamples(probes, ways), probes };
  signalsCache.set(key, result);
  if (signalsCache.size > SIGNALS_CACHE_MAX) {
    signalsCache.delete(signalsCache.keys().next().value);
  }
  return result;
}

// ---------- traffic signal clustering + synthesis (Phase 34) ----------

/**
 * Collapse per-stop-line signal nodes into one node per intersection.
 *
 * Greedy single-pass clustering: walk the nodes, and either join an existing
 * cluster whose centre is within SIGNAL_CLUSTER_M or start a new one. The
 * emitted coordinate is the cluster CENTROID, which lands in the middle of the
 * junction rather than on one of its corners — exactly where a driver expects
 * the icon. `count` is retained so the client could show how many stop lines
 * were merged, and the id is stable (lowest member id) so React keys and any
 * future dedup stay consistent across refetches.
 *
 * Pure and order-stable, therefore directly testable.
 */
function clusterSignals(signals, radiusM = SIGNAL_CLUSTER_M) {
  const clusters = [];
  for (const sig of signals) {
    if (!Number.isFinite(sig.lat) || !Number.isFinite(sig.lon)) continue;
    let joined = false;
    for (const c of clusters) {
      if (haversineM(sig.lat, sig.lon, c.lat, c.lon) <= radiusM) {
        // incremental centroid — no second pass needed
        c.members.push(sig);
        c.lat = c.members.reduce((a, m) => a + m.lat, 0) / c.members.length;
        c.lon = c.members.reduce((a, m) => a + m.lon, 0) / c.members.length;
        joined = true;
        break;
      }
    }
    if (!joined) clusters.push({ lat: sig.lat, lon: sig.lon, members: [sig] });
  }
  return clusters.map((c) => ({
    // lowest member id keeps the cluster's identity stable between fetches
    id: c.members.map((m) => String(m.id)).sort()[0],
    lon: Math.round(c.lon * 1e7) / 1e7,
    lat: Math.round(c.lat * 1e7) / 1e7,
    count: c.members.length,
    inferred: false,
  }));
}

/**
 * Infer traffic lights where OSM has none.
 *
 * THE PROBLEM: `highway=traffic_signals` is volunteer-tagged and patchy. A busy
 * signalised junction in Tiberias frequently carries no tag at all, so a purely
 * data-driven map shows an empty intersection and the countdown never appears —
 * which reads to a driver as a broken feature, not as missing data.
 *
 * PHASE 36: brute force. Every junction-like maneuver on the route gets a
 * light, unconditionally. No road class, no lane count, no probe-distance
 * ceiling — see the constants block above and inferredTrafficLights.js for why
 * the road-evidence path was producing zero lights citywide.
 *
 * `probes` and `laneSamples` are now unused. The signature is retained so the
 * activateRoute() call site is untouched, and because the lane synthesiser
 * still consumes both from the same corridor result.
 *
 * Everything inferred is LABELLED, never silently presented as surveyed fact —
 * the client shows "משוער" on these, the same contract the lane synthesiser and
 * the countdown simulation already follow.
 */
function synthesizeSignals(maneuvers, _probes, _laneSamples, realSignals) {
  if (!SIGNAL_SYNTH_ENABLED) return [];
  return synthesizeInferredSignals(maneuvers, realSignals, {
    // Phase 72: when inference is switched back on it is the CONSERVATIVE kind
    // — major roads only, corroborated by the corridor sample. Setting
    // SIGNAL_SYNTH_ENABLED=1 no longer restores Phase 36's brute force.
    majorRoadsOnly: String(process.env.SIGNAL_SYNTH_MAJOR_ONLY ?? "1") !== "0",
    laneSamples: _laneSamples,
    stackRadiusM: SIGNAL_SYNTH_STACK_M,
    realRadiusM: SIGNAL_SYNTH_DEDUP_M,
    includeRoundabouts: SIGNAL_SYNTH_ROUNDABOUTS,
    maxLights: SIGNAL_SYNTH_MAX,
  });
}

// ---------- category search fallback (Phase 29) ----------
// Overpass is the good path — real tag filtering, tight radius, ranked by
// distance. But it's a shared free endpoint and it WILL rate-limit. When it
// does, the driver still needs to find fuel, so fall back to Nominatim.
//
// Nominatim has no tag filter, so this is a bounded free-text search around the
// driver using the closest natural-language term. It's a coarser result set,
// which is precisely why it's the fallback and not the default — but a coarse
// list of fuel stations beats "החיפוש נכשל".
//
// Output is normalised to the SAME item shape as parseOverpassResponse, so the
// client can't tell which path served it.
async function fetchCategoryPoisFallback(category, lat, lon) {
  const term = CATEGORY_FALLBACK_TERMS[category];
  if (!term) return [];
  // ~0.09 degrees latitude ≈ 10km; widened by cos(lat) for longitude so the box
  // stays roughly square on the ground.
  const dLat = 0.09;
  const dLon = dLat / Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  const params = new URLSearchParams({
    q: term,
    format: "jsonv2",
    limit: "15",
    addressdetails: "1",
    // left,top,right,bottom  + bounded=1 confines results to the box
    viewbox: `${lon - dLon},${lat + dLat},${lon + dLon},${lat - dLat}`,
    bounded: "1",
  });
  await nominatimSlot();
  const res = await fetch(`${NOMINATIM_URL}/search?${params}`, {
    headers: { "User-Agent": "TiberiasNavPoC/1.0" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`nominatim HTTP ${res.status}`);
  const data = await res.json();
  const items = [];
  for (const el of Array.isArray(data) ? data : []) {
    const plat = Number(el.lat);
    const plon = Number(el.lon);
    if (!Number.isFinite(plat) || !Number.isFinite(plon)) continue;
    const name = el.name || el.display_name?.split(",")[0];
    if (!name) continue;
    items.push({
      name,
      detail: String(el.display_name || "").split(",").slice(1, 3).join(",").trim(),
      lon: plon,
      lat: plat,
      distanceM: haversineM(lat, lon, plat, plon),
    });
  }
  items.sort((a, b) => a.distanceM - b.distanceM);
  return items;
}

async function fetchCategoryPois(category, lat, lon) {
  const filter = CATEGORY_FILTERS[category];
  if (!filter) return null; // unknown category signalled to caller
  await overpassSlot();
  const body = "data=" + encodeURIComponent(overpassQuery(filter, lat, lon));
  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "TiberiasNavPoC/1.0",
    },
    body,
  });
  if (!res.ok) {
    // 429 = rate limited, 504 = the instance is overloaded. Both mean "stop
    // asking for a while" — trip the breaker so signals stand down too.
    if (res.status === 429 || res.status === 504 || res.status === 503) {
      tripOverpassBreaker(`HTTP ${res.status}`);
    }
    throw new Error(`Overpass HTTP ${res.status}`);
  }
  const data = await res.json();
  return parseOverpassResponse(data, lat, lon);
}

// ---------- external services ----------
function parseOsrmResponse(data) {
  if (!data || data.code !== "Ok" || !Array.isArray(data.routes) || data.routes.length === 0) {
    const why = (data && (data.message || data.code)) || "empty response";
    throw new Error(`OSRM: ${why}`);
  }
  const r = data.routes[0];
  const g = r.geometry;
  if (!g || g.type !== "LineString" || !Array.isArray(g.coordinates) || g.coordinates.length < 2) {
    throw new Error("OSRM: unexpected geometry shape");
  }
  const steps = Array.isArray(r.legs) ? r.legs.flatMap((leg) => (Array.isArray(leg.steps) ? leg.steps : [])) : [];
  return { geometry: g, distanceM: r.distance || 0, durationS: r.duration || 0, steps };
}

// ---------- OSRM gate: serialize routing calls with a spacing floor ----------
// Same discipline as the Nominatim and Overpass gates. Routing fires on manual
// destination-set AND on server-side auto-reroute, so without this a drifting
// driver could trigger back-to-back OSRM calls; the gate collapses them to a
// courteous cadence. Own chain — independent of the geocoder/Overpass ones.
let osrmChain = Promise.resolve(0);
function osrmSlot() {
  const run = osrmChain.then(async (lastTs) => {
    const wait = Math.max(0, lastTs + OSRM_MIN_GAP_MS - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    return Date.now();
  });
  osrmChain = run.catch(() => Date.now());
  return run;
}

// Fire-and-forget: record a completed destination as a recent search. Only
// called when we have a real name + coords (a routed suggestion/geocode), never
// for a bare-coordinate long-press. Same contract as ping/report persistence —
// the .catch means a Mongo hiccup is logged, never thrown into the route flow.
function recordSearch(deviceId, name, lon, lat) {
  if (!deviceId || !name || !Number.isFinite(lon) || !Number.isFinite(lat)) return;
  SearchHistory.create({ deviceId, name, lon, lat, ts: new Date() }).catch((e) =>
    console.warn("search not persisted:", e.message)
  );
}

// Normalize whatever the client sent into a supported profile key. Unknown or
// missing values fall back to car rather than erroring — a bad profile string
// should never cost the driver their route.
function normalizeProfile(p) {
  const key = typeof p === "string" ? p.trim().toLowerCase() : "";
  return OSRM_PROFILE_ENGINE[key] ? key : DEFAULT_PROFILE;
}

async function fetchOsrmRoute(origin, destination, profile = DEFAULT_PROFILE, prefs = {}) {
  await osrmSlot(); // courtesy spacing for the public OSRM instance
  const key = normalizeProfile(profile);
  const engine = OSRM_PROFILE_ENGINE[key];
  const coords = `${origin[0]},${origin[1]};${destination[0]},${destination[1]}`;

  // PHASE 70. Two additions, for two different jobs.
  //
  // `exclude` handles what OSRM natively supports — toll and ferry, and only
  // because the stock car profile declares them excludable. Anything else
  // (notably unpaved) returns InvalidValue, which is why osrmExcludes() filters
  // rather than passing prefs straight through.
  //
  // `alternatives` is what makes polygon avoidance possible at all. OSRM cannot
  // route around a shape, so instead we ask for several routes and pick one
  // that misses the zones. No alternatives, nothing to choose from.
  const excludes = osrmExcludes(prefs);
  const wantAlternatives = !!(prefs.avoidZones || prefs.avoidUnpaved);
  const qs = [
    "geometries=geojson",
    "overview=full",
    "steps=true",
    wantAlternatives ? "alternatives=3" : "",
    excludes.length ? `exclude=${excludes.join(",")}` : "",
  ]
    .filter(Boolean)
    .join("&");

  // path segment stays "driving" for every engine — the prefix picks the profile
  const url = `${OSRM_BASE_URL}/${engine}/route/v1/driving/${coords}?${qs}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "TiberiasNavPoC/1.0" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
  const json = await res.json();

  // Every candidate, parsed the same way. routes[0] stays first, so a caller
  // that ignores `candidates` behaves exactly as before.
  const routes = Array.isArray(json?.routes) ? json.routes : [];
  const candidates = routes
    .map((r) => {
      try {
        return parseOsrmResponse({ ...json, routes: [r] });
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const parsed = parseOsrmResponse(json);
  return { ...parsed, profile: key, candidates };
}

// One structured suggestion from a Nominatim addressdetails item. Pure, testable.
function formatSuggestion(item) {
  const lon = Number(item && item.lon);
  const lat = Number(item && item.lat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const a = (item && item.address) || {};
  const road = a.road || a.pedestrian || a.square || "";
  const primary =
    [road, a.house_number].filter(Boolean).join(" ") ||
    item.name ||
    String(item.display_name || "").split(",")[0] ||
    "";
  const locality = a.city || a.town || a.village || a.municipality || a.suburb || "";
  const detail =
    locality ||
    String(item.display_name || "").split(",").slice(1, 3).map((s) => s.trim()).filter(Boolean).join(", ");
  if (!primary.trim()) return null;
  return { name: primary.trim(), detail: String(detail).trim(), lon, lat };
}

function parseSuggestions(data) {
  if (!Array.isArray(data)) throw new Error("geocoder: unexpected response");
  return data.map(formatSuggestion).filter(Boolean).slice(0, 5);
}

const suggestCache = new Map(); // normalized query -> { items, ts }

async function suggestPlaces(query, stillWanted) {
  const key = query.toLowerCase();
  const hit = suggestCache.get(key);
  if (hit && Date.now() - hit.ts < SUGGEST_CACHE_TTL_MS) return hit.items;

  const slot = await nominatimSlot(stillWanted);
  if (slot.skipped) return null; // superseded — a newer query will answer
  const res = await fetch(`${NOMINATIM_URL}/search?${nominatimParams(query, 5)}`, {
    headers: { "User-Agent": "TiberiasNavPoC/1.0" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`geocoder HTTP ${res.status}`);
  const items = parseSuggestions(await res.json());

  if (suggestCache.size > 200) suggestCache.delete(suggestCache.keys().next().value);
  suggestCache.set(key, { items, ts: Date.now() });
  return items;
}

function parseNominatimResponse(data, query) {
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`geocoder: no results for "${query}"`);
  }
  const hit = data[0];
  const lon = Number(hit.lon);
  const lat = Number(hit.lat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    throw new Error("geocoder: unexpected result shape");
  }
  return { destination: [lon, lat], name: hit.display_name || query };
}

async function geocodeQuery(query) {
  await nominatimSlot();
  const res = await fetch(`${NOMINATIM_URL}/search?${nominatimParams(query, 1)}`, {
    headers: { "User-Agent": "TiberiasNavPoC/1.0" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`geocoder HTTP ${res.status}`);
  return parseNominatimResponse(await res.json(), query);
}

/**
 * Turn-lane layout for a step, from OSRM's intersection data.
 *
 * OSRM attaches `lanes` to intersections, shaped as
 *   [{ valid: bool, indications: ["left"|"straight"|"right"|...] }, ...]
 * ordered LEFT to RIGHT as the driver faces the junction. `valid` means the
 * lane can be used for THIS maneuver — which is exactly what lane assist needs
 * to highlight.
 *
 * A step can carry several intersections (a slip road may pass through minor
 * ones). We take the LAST intersection that has lane data, because that's the
 * one immediately at the turn — the junction the driver must be positioned for.
 *
 * Returns null when there's no lane data, which is the common case: this comes
 * from OSM `turn:lanes` tagging and coverage is patchy. The client renders
 * nothing rather than guessing a layout.
 */
function extractTurnLanes(step) {
  const intersections = step?.intersections;
  if (!Array.isArray(intersections)) return null;
  let chosen = null;
  for (const it of intersections) {
    if (Array.isArray(it?.lanes) && it.lanes.length > 0) chosen = it.lanes;
  }
  if (!chosen) return null;
  const lanes = [];
  for (const lane of chosen) {
    const indications = Array.isArray(lane?.indications)
      ? lane.indications.filter((i) => typeof i === "string")
      : [];
    lanes.push({
      valid: lane?.valid === true,
      // "none" is OSRM's marker for an unmarked lane; normalise it to straight
      // so the HUD always has an arrow to draw.
      indications: indications.length ? indications : ["none"],
    });
  }
  // A junction with more lanes than this is almost certainly bad data, and the
  // HUD can't render it legibly anyway.
  return lanes.length > 0 && lanes.length <= 8 ? lanes : null;
}

function buildDynamicRoute(geometry, distanceM, durationS, destination, destinationName, steps, profile = DEFAULT_PROFILE) {
  const line = turf.lineString(geometry.coordinates);
  const lengthM = Math.round(turf.length(line, { units: "meters" }));
  // Pin each OSRM maneuver to its position ALONG the line (meters from start),
  // so "distance to next turn" is just alongM - progressM on every ping.
  const maneuvers = (Array.isArray(steps) ? steps : [])
    .map((s) => {
      const loc = s && s.maneuver && s.maneuver.location;
      if (!Array.isArray(loc) || loc.length !== 2 || !loc.every(Number.isFinite)) return null;
      const alongM = turf.nearestPointOnLine(line, turf.point(loc), { units: "meters" }).properties.location;
      return {
        type: (s.maneuver.type || "").toLowerCase(),
        modifier: s.maneuver.modifier || null,
        name: s.name || null,
        exit: Number.isFinite(s.maneuver.exit) ? s.maneuver.exit : null,
        alongM: Math.round(alongM),
        // coordinates retained for the Phase 34 signal synthesiser, which
        // needs to know WHERE each junction maneuver happens
        lon: loc[0],
        lat: loc[1],
        lanes: extractTurnLanes(s),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.alongM - b.alongM);

  // ---------- remaining-time profile (Phase 46) ----------
  // Cumulative [metres, seconds] at every OSRM step boundary, so "time left"
  // can be interpolated from progressM instead of estimated.
  //
  // WHY NOT JUST SCALE THE TOTAL: the obvious shortcut is
  // durationS * (1 - progressM/lengthM), which silently assumes the remaining
  // road has the same average speed as the whole trip. On any route that mixes
  // Route 90 with the old town that is badly wrong in both directions — it
  // under-promises while you're on the fast section and over-promises once
  // you're into 30km/h streets, which is exactly when a driver starts trusting
  // the number. OSRM already returns per-step duration; this just keeps it.
  //
  // Built from cumulative STEP DISTANCE rather than nearestPointOnLine: step
  // distances sum to OSRM's own route distance, so the mapping to progressM
  // needs no projection and can't drift at self-intersections.
  const durationProfile = [];
  {
    let cumM = 0;
    let cumS = 0;
    for (const st of Array.isArray(steps) ? steps : []) {
      durationProfile.push([Math.round(cumM), Math.round(cumS)]);
      cumM += Number.isFinite(st?.distance) ? st.distance : 0;
      cumS += Number.isFinite(st?.duration) ? st.duration : 0;
    }
    durationProfile.push([Math.round(cumM), Math.round(cumS)]);
  }

  const feature = {
    type: "Feature",
    properties: {
      name: destinationName ? `To ${destinationName}` : "Dynamic route",
      lengthM,
      distanceM: Math.round(distanceM),
      durationS: Math.round(durationS),
      // the engine that produced this route, so the UI can label the ETA
      profile,
    },
    geometry,
  };
  // profile is retained so an auto-reroute re-uses the SAME vehicle engine —
  // a walking route must not silently become a driving route mid-trip.
  return { line, lengthM, slug: "dynamic", feature, destination, destinationName, maneuvers, durationProfile, profile, ts: Date.now() };
}

/**
 * Seconds still to drive at `progressM` along the route.
 *
 * Interpolates the cumulative profile built in buildDynamicRoute. Returns null
 * when there's no profile to read, so the client can hide the figure rather than
 * show a fabricated one.
 *
 * turf's lengthM and OSRM's own distance disagree slightly (different geodesy,
 * typically well under 1%), and progressM is measured in turf units while the
 * profile is in OSRM units. The ratio below maps between them so the two can't
 * drift apart over a long route.
 */
function remainingSecondsAt(route, progressM) {
  const prof = route?.durationProfile;
  if (!Array.isArray(prof) || prof.length < 2 || !Number.isFinite(progressM)) return null;
  const [totalM, totalS] = prof[prof.length - 1];
  if (!(totalM > 0) || !(totalS >= 0)) return null;

  const turfLen = Number.isFinite(route?.lengthM) && route.lengthM > 0 ? route.lengthM : totalM;
  const p = Math.max(0, Math.min(totalM, progressM * (totalM / turfLen)));

  // Walk to the bracketing pair. Profiles are a few dozen entries, so a linear
  // scan is cheaper than the bookkeeping a binary search would need.
  for (let i = 1; i < prof.length; i++) {
    const [m0, s0] = prof[i - 1];
    const [m1, s1] = prof[i];
    if (p <= m1) {
      const span = m1 - m0;
      const f = span > 0 ? (p - m0) / span : 0;
      const elapsed = s0 + (s1 - s0) * f;
      return Math.max(0, Math.round(totalS - elapsed));
    }
  }
  return 0;
}

// The next maneuver ahead of the driver, or null (baseline route / arrived).
function nextManeuver(route, progressM) {
  if (!route || !Array.isArray(route.maneuvers) || route.maneuvers.length === 0) return null;
  const next = route.maneuvers.find((x) => x.alongM > progressM + 10);
  if (!next) return null;
  return {
    type: next.type,
    modifier: next.modifier,
    name: next.name,
    exit: next.exit,
    distanceM: Math.max(0, Math.round(next.alongM - progressM)),
    // Phase 47: position along the route, so the client can tell one maneuver
    // from the next. It was keying voice cues on type|modifier|name, and two
    // consecutive unnamed same-direction turns — routine in the old town, since
    // OSRM reports name "" for unnamed ways — produced an IDENTICAL key. The
    // spoken-cue flags then never reset and the second turn was announced
    // silently, i.e. not at all. alongM is unique per maneuver and stable across
    // pings, which is exactly what a key needs.
    alongM: next.alongM,
    // Phase 33: turn-lane layout for the lane-assist HUD. null where OSM has
    // no turn:lanes tagging for the junction.
    lanes: next.lanes ?? null,
  };
}

// ---------- on-route engine ----------
// Is this fix too poor to judge? Crawling + imprecise = the parking-lot case.
// A stationary driver with a ±112 m fix can appear to wander 100 m per ping
// without moving an inch, so no off-route verdict can be trusted here.
// Unknown speed (null, or the -1 iOS reports when it can't measure) counts as
// slow ONLY alongside a poor fix — a good fix is still judged normally.
function isJitterSuspect(speedMs, accuracyM) {
  if (!Number.isFinite(accuracyM) || accuracyM <= REROUTE_MAX_ACCURACY_M) return false;
  const slowOrUnknown = !Number.isFinite(speedMs) || speedMs < 0 || speedMs < REROUTE_MIN_SPEED_MS;
  return slowOrUnknown;
}

// How far off the centerline we tolerate for THIS fix, on THIS route.
// base corridor + the fix's own error radius (capped) + a start-of-route grace.
function offRouteToleranceM(accuracyM, routeStartedMs, now = Date.now()) {
  let tol = ON_ROUTE_THRESHOLD_M;
  if (Number.isFinite(accuracyM) && accuracyM > 0) {
    tol += Math.min(accuracyM, OFF_ROUTE_ACCURACY_CAP_M);
  }
  if (Number.isFinite(routeStartedMs) && now - routeStartedMs < ROUTE_START_GRACE_MS) {
    tol += ROUTE_START_GRACE_M;
  }
  return tol;
}

function checkOnRoute(lon, lat, route, toleranceM = ON_ROUTE_THRESHOLD_M) {
  if (!route) {
    return {
      onRoute: null,
      distanceM: null,
      progressM: null,
      progressPct: null,
      remainingM: null,
      remainingS: null,
      route: null,
    };
  }
  const snapped = turf.nearestPointOnLine(route.line, turf.point([lon, lat]), { units: "meters" });
  const distanceM = snapped.properties.dist;
  const progressM = snapped.properties.location;
  // Phase 46: trip metrics for the bottom dashboard. Both clamp at zero so an
  // overshoot past the destination reads as "arrived", never as a negative.
  const remainingM = Number.isFinite(route.lengthM)
    ? Math.max(0, Math.round(route.lengthM - progressM))
    : null;
  return {
    onRoute: distanceM <= toleranceM,
    distanceM: Math.round(distanceM * 10) / 10,
    progressM: Math.round(progressM),
    progressPct: route.lengthM ? Math.round((1000 * progressM) / route.lengthM) / 10 : null,
    remainingM,
    remainingS: remainingSecondsAt(route, progressM),
    route: route.slug,
  };
}

function isTeleport(prev, lon, lat, tsMs) {
  if (!prev) return false;
  const dtSec = Math.max((tsMs - prev.tsMs) / 1000, 0.2);
  const jumpM = turf.distance([prev.lon, prev.lat], [lon, lat], { units: "meters" });
  return jumpM / dtSec > MAX_PLAUSIBLE_SPEED_MS;
}

// ---------- HTTP ----------
const app = express();

// Behind a cloud load balancer the socket peer is the proxy, not the client.
// This makes req.ip / X-Forwarded-For resolve to the real caller for logging.
app.set("trust proxy", 1);

// Permissive CORS for the REST endpoints. React Native's fetch isn't subject to
// browser CORS, so this is not needed by the app itself — it's here so a web
// dashboard, a curl from anywhere, or a platform health-check all work once the
// server is public. Hand-rolled rather than pulling in the `cors` package: the
// lockfile is committed and `npm ci` on the platform would fail on a dependency
// that isn't in it.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/**
 * Viewport query for the custom dataset.
 *
 *   GET /traffic-lights?bbox=minLon,minLat,maxLon,maxLat
 *
 * HTTP rather than a WebSocket frame on purpose: this is static reference data,
 * so it is cacheable, and a plain GET lets the client (and a browser, and curl)
 * check coverage without a socket. The telemetry socket carries things that
 * change; this does not.
 */
app.get("/traffic-lights", (req, res) => {
  const raw = String(req.query.bbox || "");
  const parts = raw.split(",").map(Number);
  const items =
    parts.length === 4 && parts.every(Number.isFinite)
      ? CUSTOM_SIGNALS.inBbox(parts[0], parts[1], parts[2], parts[3])
      : CUSTOM_SIGNALS.all();

  // Immutable until the next ingest, so let clients hold it.
  res.set("Cache-Control", "public, max-age=86400");
  res.json({
    type: "FeatureCollection",
    metadata: {
      total: CUSTOM_SIGNALS.count,
      returned: items.length,
      source: CUSTOM_SIGNALS.source,
      ingestedAt: CUSTOM_SIGNALS.ingestedAt,
    },
    features: items.map((p) => ({
      type: "Feature",
      properties: { id: p.id, name: p.name, custom: true },
      geometry: { type: "Point", coordinates: [p.lon, p.lat] },
    })),
  });
});

app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    // PHASE 83 — traffic-light diagnostics.
    //
    // On the test drive no signals rendered at all, and there are THREE
    // independent paths that can produce them. Working out which one is dead
    // required reading server logs; these fields answer it with one request.
    signals: {
      // 1. municipal dataset — 0 until tools/ingest-signals.mjs has been run
      customDataset: CUSTOM_SIGNALS.count,
      // 2. Overpass corridor — the only live path today. `false` means the
      //    breaker is open (rate-limited or timing out) and NO signals will
      //    appear on any route until it closes.
      overpassAvailable: overpassAvailable(),
      // 3. inference — off since Phase 55; SIGNAL_SYNTH_ENABLED=1 re-enables
      //    the conservative major-roads-only variant from Phase 72
      inferenceEnabled: SIGNAL_SYNTH_ENABLED,
      // How far along a route the corridor query can reach. A 177km route only
      // gets signals for the first stretch — this is the number that explains
      // "lights near home, none near the destination".
      corridorReachKm: Math.round((SIGNALS_MAX_PROBES * SIGNALS_SAMPLE_M) / 1000),
    },
    customSignals: CUSTOM_SIGNALS.count,
    // Phase 57: readable from a browser, so "is Mongo the problem" is one
    // request rather than a log dig.
    db: ["disconnected", "connected", "connecting", "disconnecting"][
      mongoose.connection.readyState
    ] ?? String(mongoose.connection.readyState),
    persistence: mongoReady(),
    routeLoaded: !!routeLine,
    dynamicRoutes: dynamicRoutes.size,
    suggestCache: suggestCache.size,
    activeDrivers: activeDrivers.size,
    activeReports: recentReports.length,
  })
);
app.get(`/routes/${ROUTE_SLUG}`, (_req, res) => {
  if (!routeDoc) return res.status(404).json({ error: "route not seeded — run extract_route_90.py" });
  res.json({
    type: "Feature",
    properties: { name: routeDoc.name, lengthM: routeDoc.lengthM },
    geometry: routeDoc.geometry,
  });
});
app.all("/ping", (_req, res) =>
  res.status(426).json({
    error: "telemetry is WebSocket, not REST",
    connect: `ws://<this-host>:${PORT}/track`,
    payload: '{"deviceId":"...","lon":35.54,"lat":32.79,"speed":0,"heading":0,"ts":<epoch-ms>}',
    simulator: "node simulate_ping.js",
  })
);

const server = app.listen(PORT, HOST, () => {
  // In a container the reachable address is the platform's public hostname, not
  // this bind address — so log both rather than printing a localhost URL that
  // is meaningless in production.
  const publicUrl = process.env.PUBLIC_URL || `http://<this-host>:${PORT}`;
  console.log(`HTTP + WS listening on ${HOST}:${PORT}`);
  console.log(`  health:    GET ${publicUrl}/health`);
  console.log(`  route:     GET ${publicUrl}/routes/${ROUTE_SLUG}`);
  console.log(`  telemetry: ${publicUrl.replace(/^http/, "ws")}/track  (WebSocket)`);
  console.log(
    `  routing:   OSRM ${OSRM_BASE_URL}  (gated ${OSRM_MIN_GAP_MS}ms, profiles: ` +
      Object.entries(OSRM_PROFILE_ENGINE).map(([k, v]) => `${k}->${v}`).join(", ") + ")"
  );
  console.log(`  search:    Nominatim ${NOMINATIM_URL}  (gated 1/s, cached, bias=${SEARCH_VIEWBOX || "off"})`);
  console.log(`  category:  Overpass ${OVERPASS_URL}  (gated ${OVERPASS_MIN_GAP_MS}ms, r=${OVERPASS_RADIUS_M}m)`);
});

// ---------- WebSocket: telemetry + routing + search + auto-reroute ----------
// No `verifyClient` is supplied, which means ws accepts EVERY Origin (and
// origin-less clients like React Native, which send no Origin header at all).
// That's required here: the app connects from arbitrary mobile IPs. If this
// ever needs locking down, add a verifyClient that checks info.origin — but
// note it would have to keep allowing the header-less native client.
const wss = new WebSocketServer({ server, path: "/track" });

// Cloud load balancers cut WebSocket connections that look idle (Render and
// Heroku at ~55s, Railway similar). A parked driver still holds a socket open
// while `watchPositionAsync` sends nothing, so without a keepalive the proxy
// drops them mid-session. This also reaps half-open sockets whose FIN never
// arrived — common on mobile networks handing off between cells.
const WS_HEARTBEAT_MS = Number(process.env.WS_HEARTBEAT_MS || 30000);
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate(); // never answered the previous ping — assume gone
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* socket raced shut */
    }
  }
}, WS_HEARTBEAT_MS);
heartbeat.unref?.(); // don't hold the event loop open on shutdown
wss.on("close", () => clearInterval(heartbeat));

// ---------- social live map: broadcast loop (Phase 24) ----------
// ONE shared timer for the whole server rather than a per-ping scan. Each tick
// prunes stale drivers, then sends every live driver the others within 5 km.
//
// Cost is O(n · k): n active drivers, k survivors of each one's bounding-box
// pre-filter. At PoC scale (n in the hundreds) that's a few thousand cheap
// comparisons every 3 s — negligible, and it never blocks since there's no I/O
// on this path. If n ever reaches the thousands, the upgrade is a geohash-bucket
// index so each driver only scans its own cell and the 8 around it; the
// bbox/haversine filter below would then run over that subset unchanged.
const liveMapTimer = setInterval(() => {
  const now = Date.now();
  pruneDrivers(now);
  if (activeDrivers.size < 2) return; // nobody to tell anybody about

  for (const d of activeDrivers.values()) {
    const sock = d.ws;
    if (!sock || sock.readyState !== WebSocket.OPEN) continue;
    if (!Number.isFinite(d.lat) || !Number.isFinite(d.lon)) continue;
    const drivers = nearbyDriversFor(d.deviceId, d.lat, d.lon);
    if (!drivers.length) continue; // don't spend a frame saying "nobody"
    try {
      sock.send(JSON.stringify({ type: "nearby_drivers", drivers, ts: now }));
    } catch {
      /* socket raced shut; the TTL sweep will drop it */
    }
  }
}, LIVE_BROADCAST_MS);
liveMapTimer.unref?.();

wss.on("connection", (ws, req) => {
  console.log("client connected:", req.socket.remoteAddress);
  // Heartbeat bookkeeping — see the interval above.
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });
  if (!routeLine) loadRoute().catch((e) => console.warn("route reload failed:", e.message));

  let prev = null;
  let dynRoute = null;
  let offStreak = 0;
  let rerouting = false;
  let lastRerouteMs = 0;
  let suggestSeq = 0; // latest-query-wins for autocomplete
  let lastReportMs = 0; // per-connection traffic-report cooldown
  let lastProximityScanMs = 0; // per-connection proximity-scan throttle
  let lastInteractionMs = 0; // per-connection honk/like cooldown (Phase 26)
  // Gamification (Phase 22): km travelled but not yet written to Mongo. Batched
  // so we don't issue a profile write on every ping; survives a Mongo outage in
  // memory and drains once the DB is back.
  let pendingKm = 0;
  // A flush is an async round-trip while pings keep arriving every ~2 s. Without
  // this latch a second flush could start before the first resolved and bank the
  // same kilometres twice, since pendingKm is only decremented on completion.
  let flushInFlight = false;
  let lastDeviceId = null; // so the remainder can be banked on disconnect
  // Congestion detection (Phase 23): consecutive slow-but-moving pings, and
  // where/when the streak began. Per-connection, so each driver is judged on
  // their own movement and the state dies with the socket — no global map to
  // grow or evict.
  let slowStreak = 0;
  let slowStreakStartMs = 0;

  const safeSend = (obj) => {
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify(obj));
    } catch (_e) {
      /* socket raced shut */
    }
  };

  const activateRoute = (entry, deviceId, rerouted) => {
    dynRoute = entry;
    offStreak = 0;
    rememberDynamicRoute(deviceId, entry);
    safeSend({
      type: "new_route",
      feature: entry.feature,
      destination: entry.destination,
      destinationName: entry.destinationName,
      rerouted: !!rerouted,
    });
    // Phase 28: traffic signals along this route, fetched AFTER the route is
    // on the wire and delivered as their own frame. Deliberately not awaited —
    // Overpass on the public instance can take many seconds, and no driver
    // should wait for map decoration before they can start navigating. If it
    // fails the route is entirely unaffected; the client just gets no signals.
    const coords = entry.feature?.geometry?.coordinates;
    if (Array.isArray(coords) && coords.length > 1) {
      fetchRouteCorridor(coords)
        .then(({ signals, laneSamples, probes }) => {
          // Phase 34, two steps before anything reaches the client:
          //  1. CLUSTER — Overpass emits one node per stop line, so a single
          //     junction arrives as 4-8 nodes metres apart. Collapse each
          //     group to one centroid so the map shows one icon per junction.
          //  2. SYNTHESISE — where OSM simply has no signal tagged but the
          //     route turns across a major/multi-lane road, infer one and
          //     flag it inferred:true. A blank major intersection reads as a
          //     broken feature; an honestly-labelled estimate does not.
          const clustered = clusterSignals(signals);
          const synthesized = synthesizeSignals(
            entry.maneuvers || [],
            probes,
            laneSamples,
            clustered
          );
          // PHASE 73: authoritative first. Custom signals along this corridor
          // are merged AHEAD of the OSM clusters, and mergeSignals drops any
          // OSM point within 35m of one — so where municipal data exists it
          // replaces the OSM guess rather than double-drawing beside it.
          // Where it does not, OSM still fills in. Strictly more coverage than
          // either source alone.
          const corridorCustom = CUSTOM_SIGNALS.count
            ? entry.maneuvers.flatMap((mv) =>
                Number.isFinite(mv.lat) ? CUSTOM_SIGNALS.near(mv.lon, mv.lat, 250) : []
              )
            : [];
          const uniqueCustom = [...new Map(corridorCustom.map((c) => [c.id, c])).values()];
          const allSignals = mergeSignals(uniqueCustom, [...clustered, ...synthesized]);
          // Phase 37: sent UNCONDITIONALLY, empty array included. `signals` is
          // full-state on the client (`setSignals(m.signals)` — a swap, not a
          // merge), so withholding the frame doesn't mean "no lights", it means
          // "keep whatever the LAST route had". A reroute onto a signal-free
          // road therefore used to leave the previous route's lights floating
          // over roads the driver is no longer on. An empty frame clears them.
          safeSend({ type: "route_signals", signals: allSignals });
          if (laneSamples.length) {
            // Samples are index-aligned with probes, and probes carry their own
            // coordinates, so the client can place each lane run precisely
            // without re-deriving where along the route it belongs.
            safeSend({
              type: "route_lanes",
              samples: laneSamples.map((s, i) => ({
                lat: probes[i][0],
                lon: probes[i][1],
                lanes: s.lanes,
                highway: s.highway,
                tagged: s.tagged,
                // PHASE 54: this was computed in resolveLaneSamples back in
                // Phase 51 — "lets the client place the forward carriageway on
                // the correct side of a two-way centreline" — and then dropped
                // here, so it never reached the wire. The client's whole
                // carriagewayOffsetM path has been running on `undefined`
                // (i.e. always "two-way") ever since, which is right on a
                // two-way street and wrong on every oneway one.
                oneway: !!s.oneway,
                maxspeedKmh: s.maxspeedKmh ?? null,
              })),
            });
          }
          const tagged = laneSamples.filter((s) => s.tagged).length;
          const unknown = laneSamples.filter((s) => s.lanes == null).length;
          console.log(
            `[corridor] signals: ${signals.length} raw -> ${clustered.length} clustered ` +
              `+ ${synthesized.length} inferred = ${allSignals.length} shown; ` +
              `${laneSamples.length} lane sample(s) (${tagged} tagged, ${unknown} unmatched)`
          );
        })
        .catch((e) => {
          console.warn("[corridor] lookup failed:", e.message);
          // Phase 38: fetchRouteCorridor() THROWS on a non-ok Overpass response
          // (`throw new Error("overpass " + res.status)`) and on any network
          // fault. 429 is routine on the public instance. This handler used to
          // return without sending anything, which left the PREVIOUS route's
          // lights on the map — the same stale-state bug Phase 37 closed on the
          // success path, just reached down a different branch.
          //
          // It sends the synthesiser's output rather than a bare empty array,
          // because inference has needed no Overpass data since Phase 36. The
          // breaker-open branch already does exactly this (EMPTY_CORRIDOR ->
          // synthesise -> send), so before this change one 429 produced zero
          // lights while the very next one produced a full set. Same fault,
          // two different maps. Now both degrade identically.
          //
          // For a literal empty frame instead, use `signals: []` below.
          const degraded = synthesizeSignals(entry.maneuvers || [], [], [], []);
          safeSend({ type: "route_signals", signals: degraded });
          console.log(
            `[corridor] degraded: 0 surveyed + ${degraded.length} inferred = ` +
              `${degraded.length} shown (stale lights cleared)`
          );
        });
    }
  };

  // Replay-on-connect (Phase 18): the moment a client connects, send the active
  // reports so it sees current hazards immediately — no waiting for the next
  // live report. Served from the in-memory window (pruned to the TTL first), so
  // this works even with Mongo down and never blocks the connection. Each frame
  // carries replay:true so the client can render it silently as existing state
  // rather than firing a "new hazard ahead" alert for old news.
  pruneRecentReports();
  if (recentReports.length) {
    for (const report of recentReports) {
      safeSend({ ...report, replay: true });
    }
    console.log(`[replay] sent ${recentReports.length} active report(s) to new client`);
  }

  ws.on("message", async (raw) => {
    try {
      const m = JSON.parse(raw);

      // ----- search_suggest: structured autocomplete (Phase 5) -----
      if (m.type === "search_suggest") {
        const q = (typeof m.query === "string" ? m.query : "").trim();
        if (q.length < SUGGEST_MIN_CHARS) {
          safeSend({ type: "suggestions", query: q, items: [] });
          return;
        }
        const mySeq = ++suggestSeq;
        try {
          // PHASE 70: a query that NAMES a category goes to the POI search, not
          // the geocoder. "מסעדות" through Nominatim searches place names
          // worldwide and returns a street in Belgium; through Overpass it
          // returns dinner within a few km. Needs a fix to search around, so
          // this falls through to the geocoder before the first GPS lock.
          const cat = categoryForQuery(q);
          if (cat && prev && overpassAvailable()) {
            const items = await fetchCategoryPois(cat, prev.lat, prev.lon);
            if (mySeq !== suggestSeq) return; // superseded by a newer keystroke
            safeSend({ type: "suggestions", query: q, items, category: cat });
            return;
          }
          const items = await suggestPlaces(q, () => mySeq === suggestSeq);
          if (items === null) return; // superseded by a newer keystroke
          safeSend({ type: "suggestions", query: q, items });
        } catch (err) {
          console.warn("[suggest] failed:", err.message);
          safeSend({ type: "suggestions", query: q, items: [] });
        }
        return;
      }

      // ----- traffic_report: crowd report -> broadcast to every other driver (Phase 15) -----
      if (m.type === "traffic_report") {
        if (!REPORT_TYPES.has(m.reportType)) {
          safeSend({ type: "report_error", message: "unknown report type" });
          return;
        }
        const now = Date.now();
        if (now - lastReportMs < REPORT_COOLDOWN_MS) {
          safeSend({ type: "report_error", message: "reporting too fast — wait a few seconds" });
          return;
        }
        // location: client-sent [lon,lat], else fall back to this device's last ping
        const loc =
          Array.isArray(m.location) &&
          m.location.length === 2 &&
          m.location.every(Number.isFinite) &&
          Math.abs(m.location[0]) <= 180 &&
          Math.abs(m.location[1]) <= 90
            ? m.location
            : prev
              ? [prev.lon, prev.lat]
              : null;
        if (!loc) {
          safeSend({ type: "report_error", message: "no known location for this report" });
          return;
        }
        lastReportMs = now;
        const { report, fanout } = publishReport({
          reportType: m.reportType,
          location: loc,
          deviceId: m.deviceId ?? null,
          excludeWs: ws, // the reporter gets an ack instead of their own broadcast
          now,
        });
        safeSend({ type: "report_ack", id: report.id });
        // Gamification (Phase 22): reward the contribution. Deliberately after
        // the ack and unawaited — a slow or absent DB must never delay, or
        // fail, a hazard report. The helper no-ops entirely when Mongo is down.
        awardPoints(report.deviceId, POINTS_PER_REPORT, `report:${report.reportType}`).catch(
          () => {}
        );
        console.log(
          `[report] ${report.deviceId || "anon"} ${report.reportType} @ ${loc[0].toFixed(5)},${loc[1].toFixed(5)} -> ${fanout} client(s)`
        );
        return;
      }

      // ----- category_search: nearby POIs by category via Overpass (Phase 17) -----
      if (m.type === "category_search") {
        const category = String(m.category || "");
        if (!CATEGORY_FILTERS[category]) {
          safeSend({ type: "category_results", category, items: [], error: "unknown category" });
          return;
        }
        // origin: client lat/lon if valid, else this device's last ping
        const lat = Number.isFinite(m.lat) ? m.lat : prev ? prev.lat : null;
        const lon = Number.isFinite(m.lon) ? m.lon : prev ? prev.lon : null;
        if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
          safeSend({ type: "category_results", category, items: [], error: "no valid location" });
          return;
        }
        // Overpass first; Nominatim if it's unavailable or fails. The client is
        // told which source answered so it can label a coarse result set, but
        // it never has to render a bare failure just because a shared free API
        // is busy.
        const runCategory = async () => {
          if (overpassAvailable()) {
            try {
              const items = await fetchCategoryPois(category, lat, lon);
              return { items: items || [], source: "overpass" };
            } catch (err) {
              console.warn(`[category] overpass failed for ${category}:`, err.message);
            }
          }
          const items = await fetchCategoryPoisFallback(category, lat, lon);
          return { items, source: "nominatim" };
        };

        runCategory()
          .then(({ items, source }) => {
            safeSend({ type: "category_results", category, items, source });
            console.log(
              `[category] ${category} @ ${lat.toFixed(4)},${lon.toFixed(4)} -> ` +
                `${items.length} POIs via ${source}`
            );
          })
          .catch((err) => {
            // Both paths failed: return an EMPTY LIST, not an error. The UI
            // shows "nothing found nearby", which is honest and recoverable,
            // rather than a red failure the driver can do nothing about.
            safeSend({ type: "category_results", category, items: [], source: "none" });
            console.warn(`[category] ${category} fallback also failed:`, err.message);
          });
        return;
      }

      // ----- hello: identify the running client build (Phase 52) -----
      // Two field reports in a row described bugs that were already fixed in a
      // build that hadn't been flashed. One log line makes that unambiguous.
      if (m.type === "hello") {
        console.log(
          `[client] ${String(m.deviceId ?? "?").slice(0, 12)} connected, build ${m.build ?? "unknown"}`
        );
        return;
      }

      // ----- get_recent_searches: this device's latest unique destinations (Phase 20) -----
      if (m.type === "get_recent_searches") {
        const deviceId = typeof m.deviceId === "string" ? m.deviceId : null;
        // Mongo-down guard: reads are request/response, so never await a query
        // that could hang/throw — just return empty and let the client show its
        // own placeholder. (Writes elsewhere stay fire-and-forget.)
        if (!deviceId || !mongoReady()) {
          safeSend({ type: "recent_searches_results", items: [] });
          return;
        }
        // Top 5 UNIQUE by name, most-recent first: group by name keeping each
        // name's newest hit, sort by that time, cap at 5. Dedup means routing to
        // the same place twice shows one row, not two.
        SearchHistory.aggregate([
          { $match: { deviceId } },
          { $sort: { ts: -1 } },
          { $group: { _id: "$name", name: { $first: "$name" }, lon: { $first: "$lon" }, lat: { $first: "$lat" }, ts: { $first: "$ts" } } },
          { $sort: { ts: -1 } },
          { $limit: 5 },
          { $project: { _id: 0, name: 1, lon: 1, lat: 1 } },
        ])
          .then((rows) => safeSend({ type: "recent_searches_results", items: rows }))
          .catch((e) => {
            console.warn("[recent] query failed:", e.message);
            safeSend({ type: "recent_searches_results", items: [] });
          });
        return;
      }

      // ----- get_profile: gamification stats for this device (Phase 22) -----
      if (m.type === "get_profile") {
        const deviceId = typeof m.deviceId === "string" ? m.deviceId : null;
        // Same discipline as get_recent_searches: this is request/response, so
        // never await a query that could hang. A missing device, a missing
        // profile and a downed DB all resolve to the same friendly zero state —
        // `persisted` tells the client which it is, so it can distinguish
        // "nothing earned yet" from "stats unavailable right now".
        const blank = {
          type: "profile_results",
          points: 0,
          totalDistanceKm: 0,
          rank: DEFAULT_RANK,
          savedPlaces: [],
          persisted: false,
        };
        if (!deviceId || !mongoReady()) {
          safeSend(blank);
          return;
        }
        User.findOne({ deviceId })
          .lean()
          .then((doc) => {
            if (!doc) {
              safeSend({ ...blank, persisted: true }); // known-empty, DB is up
              return;
            }
            safeSend({
              type: "profile_results",
              points: doc.points || 0,
              // one decimal is plenty for a display odometer
              totalDistanceKm: Math.round((doc.totalDistanceKm || 0) * 10) / 10,
              rank: doc.rank || rankForPoints(doc.points || 0),
              savedPlaces: serializeSavedPlaces(doc.savedPlaces),
              persisted: true,
            });
          })
          .catch((e) => {
            console.warn("[profile] query failed:", e.message);
            safeSend(blank);
          });
        return;
      }

      // ----- save_place / delete_place: favourites, Home & Work (Phase 25) -----
      // Both reply with the FULL updated list, so the client replaces state
      // wholesale instead of patching — the same "each frame is the whole
      // picture" contract as nearby_drivers, and it can't drift out of sync.
      if (m.type === "save_place") {
        const deviceId = typeof m.deviceId === "string" ? m.deviceId : null;
        saveUserPlace(deviceId, {
          label: m.label,
          address: m.address,
          lat: m.lat,
          lon: m.lon,
        })
          .then((res) => {
            if (!res.ok) {
              safeSend({
                type: "place_error",
                message:
                  res.reason === "unavailable"
                    ? "storage unavailable — try again later"
                    : "could not save this place",
              });
              return;
            }
            safeSend({ type: "saved_places", places: res.places, saved: res.place.label });
          })
          .catch(() => safeSend({ type: "place_error", message: "could not save this place" }));
        return;
      }

      if (m.type === "delete_place") {
        const deviceId = typeof m.deviceId === "string" ? m.deviceId : null;
        deleteUserPlace(deviceId, { placeId: m.placeId, label: m.label })
          .then((res) => {
            if (!res.ok) {
              safeSend({
                type: "place_error",
                message:
                  res.reason === "unavailable"
                    ? "storage unavailable — try again later"
                    : "could not delete this place",
              });
              return;
            }
            safeSend({ type: "saved_places", places: res.places, deleted: m.placeId ?? m.label });
          })
          .catch(() => safeSend({ type: "place_error", message: "could not delete this place" }));
        return;
      }

      // ----- send_interaction: honk / like another driver (Phase 26) -----
      // Routed purely through the in-memory registry: the target must be a
      // live, currently-connected driver. Nothing is queued for offline
      // devices — a honk is only meaningful in the moment.
      if (m.type === "send_interaction") {
        const now = Date.now();
        const fromId = typeof m.deviceId === "string" ? m.deviceId : null;
        const targetId = typeof m.targetDeviceId === "string" ? m.targetDeviceId : null;
        // `interactionType` on the wire, so it can't be confused with the
        // envelope's own `type` discriminator.
        const kind = typeof m.interactionType === "string" ? m.interactionType : null;
        const interaction = kind && INTERACTION_TYPES.has(kind) ? kind : null;

        if (!fromId || !targetId || !interaction) {
          safeSend({ type: "interaction_error", message: "bad interaction" });
          return;
        }
        if (fromId === targetId) {
          safeSend({ type: "interaction_error", message: "cannot interact with yourself" });
          return;
        }
        if (now - lastInteractionMs < INTERACTION_COOLDOWN_MS) {
          safeSend({
            type: "interaction_error",
            message: `slow down — ${Math.ceil(
              (INTERACTION_COOLDOWN_MS - (now - lastInteractionMs)) / 1000
            )}s`,
          });
          return;
        }
        const pairKey = `${fromId}>${targetId}`;
        const lastPair = interactionPairs.get(pairKey) ?? 0;
        if (now - lastPair < INTERACTION_PAIR_COOLDOWN_MS) {
          safeSend({
            type: "interaction_error",
            message: "already sent to this driver recently",
          });
          return;
        }
        const target = activeDrivers.get(targetId);
        if (!target || !target.ws || target.ws.readyState !== WebSocket.OPEN) {
          safeSend({ type: "interaction_error", message: "driver is no longer nearby" });
          return;
        }

        lastInteractionMs = now;
        interactionPairs.set(pairKey, now);
        pruneInteractionPairs(now);

        // The sender's rank is read from the registry (already cached there for
        // the live map), so this costs no DB round-trip.
        const fromRank = activeDrivers.get(fromId)?.rank ?? DEFAULT_RANK;
        try {
          target.ws.send(
            JSON.stringify({
              type: "incoming_interaction",
              // NB: the payload field is `interaction`, not `type` — the
              // envelope already uses `type` as its discriminator, and nesting
              // a second `type` inside it would be ambiguous to parse.
              interaction,
              fromRank,
              ts: now,
            })
          );
        } catch {
          safeSend({ type: "interaction_error", message: "could not reach that driver" });
          return;
        }

        // A like is worth points TO THE RECIPIENT. Fire-and-forget, after the
        // delivery — gamification must never delay or block the social event.
        if (interaction === "like") {
          awardPoints(targetId, POINTS_PER_LIKE, "like received").catch(() => {});
        }
        safeSend({ type: "interaction_sent", interaction, targetDeviceId: targetId });
        console.log(`[social] ${fromId} -> ${targetId} : ${interaction}`);
        return;
      }

      // ----- vote_report: crowd validation of an active report (Phase 34) -----
      // {type:"vote_report", deviceId, reportId, vote:"up"|"down"}
      // Up-votes refresh confidence; enough down-votes retire the report for
      // everyone. Purely in-memory and tied to the same recentReports window,
      // so it works with Mongo down like every other report path.
      if (m.type === "vote_report") {
        const reportId = typeof m.reportId === "string" ? m.reportId : null;
        const vote = m.vote === "up" ? 1 : m.vote === "down" ? -1 : 0;
        const voter = typeof m.deviceId === "string" ? m.deviceId : null;
        if (!reportId || !vote || !voter) {
          safeSend({ type: "vote_error", message: "bad vote" });
          return;
        }
        // Only vote on something still active — a report already retired or
        // expired must not be resurrected by a late vote.
        pruneRecentReports();
        const idx = recentReports.findIndex((r) => r.id === reportId);
        if (idx === -1) {
          safeSend({ type: "vote_error", reportId, message: "report no longer active" });
          return;
        }
        let rec = reportVotes.get(reportId);
        if (!rec) {
          rec = { score: 0, voters: new Set() };
          reportVotes.set(reportId, rec);
        }
        if (rec.voters.has(voter)) {
          // Idempotent, not an error: a double-tap shouldn't read as a failure.
          safeSend({ type: "vote_ack", reportId, score: rec.score, counted: false });
          return;
        }
        rec.voters.add(voter);
        rec.score += vote;
        safeSend({ type: "vote_ack", reportId, score: rec.score, counted: true });

        if (rec.score <= REPORT_RETIRE_SCORE) {
          // Retire it: drop from the replay window and tell EVERY client to
          // remove the pin, so the map converges for all drivers at once.
          recentReports.splice(idx, 1);
          reportVotes.delete(reportId);
          const frame = JSON.stringify({ type: "report_removed", reportId });
          for (const client of wss.clients) {
            if (client.readyState === WebSocket.OPEN) client.send(frame);
          }
          // best-effort durable delete; never blocks the broadcast
          Report.deleteOne({ _id: reportId }).catch(() => {});
          console.log(`[vote] ${reportId} retired by crowd (score ${rec.score})`);
        } else {
          console.log(`[vote] ${reportId} ${vote > 0 ? "+1" : "-1"} -> ${rec.score}`);
        }
        return;
      }

      // ----- clear_search_history: wipe THIS device's recent destinations -----
      // Phase 29. Scoped strictly to the caller's deviceId — a client can only
      // ever delete its own rows. Mirrors the read path's guard: with Mongo
      // down we still answer (with an empty list) so the UI can clear itself
      // and never hangs waiting on a DB that isn't there.
      if (m.type === "clear_search_history") {
        const deviceId = typeof m.deviceId === "string" ? m.deviceId : null;
        if (!deviceId || !mongoReady()) {
          safeSend({ type: "recent_searches_results", items: [], cleared: true });
          return;
        }
        SearchHistory.deleteMany({ deviceId })
          .then((r) => {
            safeSend({ type: "recent_searches_results", items: [], cleared: true });
            console.log(`[recent] cleared ${r?.deletedCount ?? 0} search(es) for ${deviceId}`);
          })
          .catch((e) => {
            console.warn("[recent] clear failed:", e.message);
            // Report the failure rather than pretending: the client keeps its
            // list instead of showing a cleared state that didn't persist.
            safeSend({ type: "recent_searches_error", message: "clear failed" });
          });
        return;
      }

      // ----- delete_search_history_item: drop ONE recent destination (Phase 50) -----
      // The list is server-side, so a long-press delete in the UI has to be a
      // server operation — there is no local array to splice. Same guard as
      // the clear path: scoped strictly to the caller's deviceId, so a client
      // can only ever remove its own rows.
      //
      // Matched on NAME, not coordinates, because that is exactly what the
      // read path groups by: it returns the top 5 unique-by-name destinations,
      // so one visible row IS all the rows sharing that name. Deleting by name
      // therefore removes precisely what the user long-pressed, and nothing
      // else. (Coordinates would be the wrong key twice over — they never
      // survive a float round-trip cleanly, and a name-grouped row can carry
      // rows whose coordinates differ slightly between visits.)
      if (m.type === "delete_search_history_item") {
        const deviceId = typeof m.deviceId === "string" ? m.deviceId : null;
        const name = typeof m.name === "string" ? m.name.trim() : "";
        if (!deviceId || !name) {
          safeSend({ type: "recent_searches_error", message: "bad delete request" });
          return;
        }
        if (!mongoReady()) {
          // Be honest rather than pretending: without the DB nothing was
          // deleted, and the client keeps its row instead of showing a
          // removal that would reappear on the next fetch.
          safeSend({ type: "recent_searches_error", message: "history unavailable" });
          return;
        }
        SearchHistory.deleteMany({ deviceId, name })
          .then((r) => {
            console.log(`[recent] deleted ${r?.deletedCount ?? 0} row(s) for ${deviceId}`);
            // Re-run the read path's aggregate VERBATIM, so the client gets the
            // authoritative list back rather than patching its own copy — and
            // so the two can never drift into returning different shapes.
            return SearchHistory.aggregate([
              { $match: { deviceId } },
              { $sort: { ts: -1 } },
              { $group: { _id: "$name", name: { $first: "$name" }, lon: { $first: "$lon" }, lat: { $first: "$lat" }, ts: { $first: "$ts" } } },
              { $sort: { ts: -1 } },
              { $limit: 5 },
              { $project: { _id: 0, name: 1, lon: 1, lat: 1 } },
            ]);
          })
          .then((rows) => safeSend({ type: "recent_searches_results", items: rows || [] }))
          .catch((e) => {
            console.warn("[recent] delete failed:", e.message);
            safeSend({ type: "recent_searches_error", message: "delete failed" });
          });
        return;
      }

      // ----- set_destination: coordinates (long-press / suggestion tap) or free text -----
      if (m.type === "set_destination") {
        const origin =
          (prev && [prev.lon, prev.lat]) ||
          (Array.isArray(m.origin) && m.origin.length === 2 && m.origin.every(Number.isFinite)
            ? m.origin
            : null);
        if (!origin) {
          safeSend({ type: "route_error", message: "no known location yet — wait for a GPS fix" });
          return;
        }
        try {
          let destination = null;
          let destinationName =
            typeof m.destinationName === "string" && m.destinationName.trim()
              ? m.destinationName.trim()
              : null;
          if (Array.isArray(m.destination) && m.destination.length === 2 && m.destination.every(Number.isFinite)) {
            destination = m.destination;
          } else if (typeof m.query === "string" && m.query.trim()) {
            const hit = await geocodeQuery(m.query.trim());
            destination = hit.destination;
            destinationName = hit.name;
          } else {
            throw new Error('set_destination needs destination:[lon,lat] or query:"text"');
          }
          // Phase 29: vehicle profile chosen in the UI (car | motorcycle | foot).
          // Unknown/absent falls back to car inside normalizeProfile.
          const profile = normalizeProfile(m.profile);

          // ---------- routing preferences (Phase 70) ----------
          // Sent by the client's settings toggles. Absent means "no preference",
          // which is the pre-Phase-70 behaviour exactly.
          const rp = m.routePrefs && typeof m.routePrefs === "object" ? m.routePrefs : {};
          const prefs = {
            avoidToll: !!rp.avoidToll,
            avoidUnpaved: !!rp.avoidUnpaved,
            // Only meaningful if the operator actually loaded zones.
            avoidZones: !!rp.avoidZones && AVOID_ZONES.length > 0,
          };

          const osrmResult = await fetchOsrmRoute(origin, destination, profile, prefs);

          // Pick among candidates. With no preferences set there is one
          // candidate and this returns it unchanged, so the cost is nil.
          const pick = chooseRoute(
            osrmResult.candidates?.length ? osrmResult.candidates : [osrmResult],
            { zones: prefs.avoidZones ? AVOID_ZONES : [], avoidUnpaved: prefs.avoidUnpaved }
          );
          const { geometry, distanceM, durationS, steps } = pick.chosen ?? osrmResult;

          // Tell the driver when the route is not the fastest one. A silently
          // longer route reads as the app being wrong, and "avoided a restricted
          // area" is information they may need before setting off.
          if (pick.reason === "avoided-zone") {
            safeSend({
              type: "route_notice",
              message: `נמצא מסלול חלופי (${(pick.avoidedZones || []).join(", ")})`,
            });
          } else if (pick.reason === "all-candidates-blocked") {
            safeSend({
              type: "route_notice",
              level: "warn",
              message: "כל המסלולים עוברים באזור מוגבל — נדרשת תשומת לב",
            });
          }

          activateRoute(
            buildDynamicRoute(geometry, distanceM, durationS, destination, destinationName, steps, profile),
            m.deviceId,
            false
          );
          // persist as a recent search (fire-and-forget) — only with a real
          // name, so bare-coordinate long-presses don't clutter the list
          if (destinationName) recordSearch(m.deviceId, destinationName, destination[0], destination[1]);
          console.log(
            `[route] ${m.deviceId || "anon"} -> ${destinationName || destination.map((n) => n.toFixed(5)).join(",")}` +
              ` : ${(dynRoute.lengthM / 1000).toFixed(2)} km, ~${Math.round(dynRoute.feature.properties.durationS / 60)} min`
          );
        } catch (err) {
          safeSend({ type: "route_error", message: err.message });
          console.warn("[route] failed:", err.message);
        }
        return;
      }

      // ----- telemetry ping (untyped, back-compatible) -----
      if (typeof m.lon !== "number" || typeof m.lat !== "number") {
        throw new Error("payload must include numeric lon and lat");
      }
      const ts = m.ts ? new Date(m.ts) : new Date();

      if (isTeleport(prev, m.lon, m.lat, ts.getTime())) {
        safeSend({ type: "rejected", reason: "implausible jump (GPS glitch)" });
        return;
      }

      // Gamification (Phase 22): bank the distance covered since the last fix.
      // Sits AFTER the teleport guard on purpose, so a GPS glitch can't inflate
      // anyone's odometer. The step is also capped — the guard only rejects the
      // physically impossible, and a coarse first fix can still land a long way
      // from the previous one without being a "jump".
      if (prev && m.deviceId) {
        lastDeviceId = m.deviceId;
        const stepKm = haversineM(prev.lat, prev.lon, m.lat, m.lon) / 1000;
        if (stepKm > 0 && stepKm <= MAX_STEP_KM && pendingKm < MAX_PENDING_KM) {
          pendingKm += stepKm;
        }
        // Flush in batches. If Mongo is down the helper no-ops and returns null,
        // so we keep the remainder and retry on a later ping instead of losing it.
        if (!flushInFlight && pendingKm >= DISTANCE_FLUSH_KM) {
          const flushKm = pendingKm;
          const deviceId = m.deviceId;
          flushInFlight = true;
          addDistanceKm(deviceId, flushKm)
            .then((doc) => {
              if (doc) pendingKm = Math.max(0, pendingKm - flushKm); // banked
            })
            .catch(() => {
              /* helper already logged; remainder stays pending */
            })
            .finally(() => {
              flushInFlight = false;
            });
        }
      }

      // ---- social live map (Phase 24): keep this driver in the registry ----
      // O(1) upsert. The 5 km scan and fan-out happen on a single shared timer
      // (see the broadcast loop), NOT here — so telemetry throughput is
      // unaffected by how many drivers are online.
      if (m.deviceId) {
        lastDeviceId = m.deviceId; // also used by the close handler + distance flush
        touchDriver({
          deviceId: m.deviceId,
          lon: m.lon,
          lat: m.lat,
          heading: typeof m.heading === "number" ? m.heading : -1,
          speed: typeof m.speed === "number" ? m.speed : -1,
          // Needed by the density rule: a loose fix can't corroborate a jam.
          accuracy: typeof m.accuracy === "number" ? m.accuracy : -1,
          ws,
          now: ts.getTime(),
        });
      }

      // ---- automatic congestion detection (Phase 23, density rule Phase 27) ----
      // Two independent conditions must BOTH hold before a jam is invented:
      //
      //   1. PERSISTENCE — this driver has been crawling for N consecutive
      //      qualifying fixes (not a single blip at a give-way line).
      //   2. DENSITY — at that moment, >= CLUSTER_MIN_DRIVERS distinct devices
      //      are crawling within CLUSTER_RADIUS_M of each other.
      //
      // (1) alone was the old rule, and it fired for a lone pedestrian or a
      // phone drifting indoors. (2) is what makes it a road condition rather
      // than one device's anecdote. Everything here is O(1) except the cluster
      // scan, which only runs on the ping that completes a streak.
      //
      // NOTE: this gates DETECTION only. The fix itself is always stored,
      // mapped and sent onward regardless of accuracy — see isCongestedSample.
      {
        const speedMs = typeof m.speed === "number" ? m.speed : -1;
        const accuracyM = typeof m.accuracy === "number" ? m.accuracy : -1;
        if (isCongestedSample(speedMs, accuracyM)) {
          if (slowStreak === 0) slowStreakStartMs = ts.getTime();
          slowStreak++;
          const spanMs = ts.getTime() - slowStreakStartMs;
          if (slowStreak >= CONGESTION_MIN_PINGS && spanMs >= CONGESTION_MIN_SPAN_MS) {
            // Reset first: the streak has been consumed whether or not it
            // becomes a report, so later slow pings can't re-enter and hammer
            // the cluster scan.
            slowStreak = 0;
            const nowMs = ts.getTime();
            const { count, members } = countCongestedCluster(m.lat, m.lon, nowMs);
            if (count < CLUSTER_MIN_DRIVERS) {
              // Persistent but solitary — a walker, a parking manoeuvre, or
              // indoor drift. Deliberately silent: this is the common case.
              console.log(
                `[auto-jam] skipped: only ${count} congested driver(s) within ${CLUSTER_RADIUS_M}m`
              );
            } else if (!hasNearbyAutoJam(m.lon, m.lat, nowMs)) {
              autoJams.push({ lon: m.lon, lat: m.lat, ts: nowMs });
              const { fanout } = publishReport({
                reportType: JAM_REPORT_TYPE,
                location: [m.lon, m.lat],
                deviceId: AUTO_REPORT_DEVICE_ID,
                excludeWs: null,
                now: nowMs,
              });
              console.log(
                `[auto-jam] ${count} drivers @ ${(speedMs * 3.6).toFixed(1)} km/h ` +
                  `${m.lon.toFixed(5)},${m.lat.toFixed(5)} [${members.join(",")}] -> ${fanout} client(s)`
              );
            }
          }
        } else {
          // Anything outside the congestion band — flowing, stopped, too
          // imprecise, or unknown — breaks the run. Congestion must be
          // sustained AND consecutive.
          slowStreak = 0;
        }
      }

      prev = { lon: m.lon, lat: m.lat, tsMs: ts.getTime() };

      // V2X proximity alerts (Phase 21): warn on approach to an active report.
      // Throttled per connection so a burst of fast telemetry doesn't re-scan
      // every ping — the scan is cheap (small pruned window + bbox pre-filter)
      // but there's no reason to run it more than every few seconds per device.
      {
        const nowMs = ts.getTime();
        if (m.deviceId && nowMs - lastProximityScanMs >= PROXIMITY_SCAN_MIN_GAP_MS) {
          lastProximityScanMs = nowMs;
          for (const hit of proximityAlertsFor(m.deviceId, m.lat, m.lon, nowMs)) {
            safeSend({
              type: "proximity_alert",
              reportId: hit.reportId,
              reportType: hit.reportType,
              distanceMeters: hit.distanceMeters,
              message: `${hit.reportType} ${hit.distanceMeters}m ahead`,
            });
            console.log(`[proximity] ${m.deviceId} <- ${hit.reportType} @ ${hit.distanceMeters}m`);
          }
        }
      }

      if (!dynRoute && m.deviceId && dynamicRoutes.has(m.deviceId)) {
        activateRoute(dynamicRoutes.get(m.deviceId), m.deviceId, false);
      }

      const route =
        dynRoute || (routeLine ? { line: routeLine, lengthM: routeDoc && routeDoc.lengthM, slug: ROUTE_SLUG } : null);

      // Anti-jitter (Phase 29). The corridor widens with the fix's own error
      // radius and during the start-of-route grace window, so an imprecise fix
      // can't manufacture an off-route verdict. The jitter gate is stronger
      // still: crawling + imprecise means we decline to judge at all.
      const jitterSuspect = isJitterSuspect(m.speed, m.accuracy);
      const toleranceM = offRouteToleranceM(m.accuracy, dynRoute && dynRoute.ts);
      const status = checkOnRoute(m.lon, m.lat, route, toleranceM);
      if (jitterSuspect && status.onRoute === false) {
        // Hold the last trustworthy verdict instead of reporting a bogus one:
        // the UI must not flash "recalculating" at a parked car.
        status.onRoute = true;
        status.jitter = true;
      }

      // auto-reroute: the Waze reflex
      if (status.route === "dynamic" && status.onRoute === false && !jitterSuspect) {
        offStreak += 1;
      } else {
        offStreak = 0; // back on course, or the fix is too poor to judge
      }
      if (
        offStreak >= REROUTE_AFTER_OFF_PINGS &&
        dynRoute &&
        dynRoute.destination &&
        !rerouting &&
        Date.now() - lastRerouteMs > REROUTE_COOLDOWN_MS
      ) {
        rerouting = true;
        lastRerouteMs = Date.now();
        const from = [m.lon, m.lat];
        const dev = m.deviceId;
        const { destination, destinationName } = dynRoute;
        // keep the driver's vehicle: a walking route stays a walking route
        const activeProfile = normalizeProfile(dynRoute.profile);
        (async () => {
          try {
            const { geometry, distanceM, durationS, steps } = await fetchOsrmRoute(from, destination, activeProfile);
            activateRoute(
              buildDynamicRoute(geometry, distanceM, durationS, destination, destinationName, steps, activeProfile),
              dev,
              true
            );
            console.log(
              `[reroute] ${dev || "anon"} off x${REROUTE_AFTER_OFF_PINGS} -> new path ${(dynRoute.lengthM / 1000).toFixed(2)} km`
            );
          } catch (err) {
            console.warn("[reroute] failed:", err.message);
          } finally {
            rerouting = false;
          }
        })();
      }

      Ping.create({
        deviceId: m.deviceId,
        loc: { type: "Point", coordinates: [m.lon, m.lat] },
        speed: m.speed,
        heading: m.heading,
        accuracy: m.accuracy,
        onRoute: status.onRoute,
        distanceM: status.distanceM,
        progressM: status.progressM,
        routeSlug: status.route,
        ts,
      }).catch((dbErr) => warnDbOnce("ping persist", dbErr.message));

      const maneuver = nextManeuver(dynRoute && route === dynRoute ? dynRoute : null, status.progressM || 0);

      console.log(
        `[ping] ${m.deviceId || "anon"} ${m.lon.toFixed(5)},${m.lat.toFixed(5)}` +
          ` -> onRoute=${status.onRoute} dist=${status.distanceM}m progress=${status.progressM}m route=${status.route}` +
          (dynRoute ? ` tol=${Math.round(toleranceM)}m` : "") +
          (jitterSuspect ? ` JITTER(acc=${Math.round(m.accuracy)}m,spd=${m.speed})` : "") +
          (offStreak ? ` offStreak=${offStreak}` : "") +
          (maneuver ? ` next=${maneuver.modifier || maneuver.type}@${maneuver.distanceM}m` : "")
      );
      safeSend({ type: "status", ...status, maneuver });
    } catch (err) {
      safeSend({ type: "error", message: err.message });
    }
  });

  ws.on("close", () => {
    // Social live map (Phase 24): drop this driver immediately rather than
    // waiting out the TTL — but ONLY if the registry still points at this
    // socket. A reconnect races ahead of the old socket's close event, and
    // deleting then would erase the fresh session.
    if (lastDeviceId) {
      const d = activeDrivers.get(lastDeviceId);
      if (d && d.ws === ws) activeDrivers.delete(lastDeviceId);
    }
    // Bank whatever distance hadn't reached the flush threshold, so ending a
    // drive mid-batch doesn't quietly discard the last few hundred metres.
    // Fire-and-forget: the socket is already gone, nobody is waiting on this.
    if (lastDeviceId && pendingKm > 0) {
      addDistanceKm(lastDeviceId, pendingKm).catch(() => {});
      pendingKm = 0;
    }
    console.log("client disconnected");
  });
});

// ---------- boot ----------
// Mongo is OPTIONAL: telemetry, reports, and replay all work without it (the
// in-memory report window is the live replay source). So a Mongo failure logs
// and continues rather than exiting — the WS server (already listening above)
// keeps serving. On success we rehydrate the replay window once from recent
// persisted reports, so a server restart doesn't blank out active hazards.
mongoose
  .connect(MONGO_URI, {
    // Atlas over the public internet: fail fast and loudly rather than hanging
    // boot for the 30s default. The .catch below already degrades to
    // no-persistence mode, so a wrong URI costs a warning, not an outage.
    serverSelectionTimeoutMS: Number(process.env.MONGO_TIMEOUT_MS || 8000),
  })
  .then(() => console.log("MongoDB connected"))
  .then(loadRoute)
  .then(rehydrateRecentReports)
  .catch((err) => {
    // PHASE 57: this used to call loadRoute() again right here — re-issuing the
    // query that had just failed, against a connection we had this instant
    // established was down. That is where the second log line came from. There
    // is nothing to retry synchronously; the reconnect handler below picks the
    // route up if and when Mongo appears.
    console.warn("Mongo unavailable — running without persistence:", err.message);
    console.warn(
      "  live tracking, OSRM routing and the WebSocket are unaffected; " +
        "the seeded Route 90 corridor and history/gamification are disabled."
    );
    if (!process.env.MONGO_URI) {
      console.warn(
        "  MONGO_URI is unset, so the default mongodb://localhost:27017 was used. " +
          "On a hosted platform set MONGO_URI to an Atlas connection string to restore persistence."
      );
    }
  });

// ---------- connection lifecycle (Phase 57) ----------
// Without these, a mid-flight Mongo drop surfaces as an unhandled rejection and
// a reconnection leaves the process permanently in degraded mode even though
// the database is back.
mongoose.connection.on("error", (err) => warnDbOnce("connection", err?.message || "error"));
mongoose.connection.on("disconnected", () => {
  console.warn("[db] disconnected — continuing in memory");
});
mongoose.connection.on("connected", () => {
  console.log("[db] connected");
  // Pick up whatever we couldn't read while it was down.
  loadRoute().catch((e) => console.warn("[db] route reload failed:", e.message));
  rehydrateRecentReports().catch(() => {});
});

// Best-effort: refill the in-memory replay window from Mongo at startup, so
// reports created before a restart are still replayed to new clients. Rebuilds
// the exact broadcast frame shape. Never throws into boot.
async function rehydrateRecentReports() {
  try {
    const since = new Date(Date.now() - REPORT_TTL_MS);
    // PHASE 57: guarded. This runs from the connect chain AND from the reconnect
    // handler, so it is reachable at exactly the moments Mongo is least likely
    // to be there. An empty array means "no hazards to replay", which is the
    // correct degraded state — not an error.
    const docs = await withDb("report rehydrate", [], () =>
      Report.find({ ts: { $gte: since } }).sort({ ts: 1 }).limit(200).lean()
    );
    for (const d of docs) {
      const ts = new Date(d.ts).getTime();
      recentReports.push({
        type: "traffic_report",
        id: `${ts.toString(36)}-${String(d._id).slice(-6)}`,
        reportType: d.reportType,
        location: d.loc?.coordinates ?? null,
        deviceId: d.deviceId ?? null,
        ts,
      });
      // Rebuild the congestion dedup index too (Phase 23). Without this, a
      // restart wipes the suppression window and the next slow driver
      // immediately re-reports a jam the server already knows about. Only
      // system-authored jams count — a manual "Traffic Jam" report shouldn't
      // block automatic detection.
      if (
        d.reportType === JAM_REPORT_TYPE &&
        d.deviceId === AUTO_REPORT_DEVICE_ID &&
        Array.isArray(d.loc?.coordinates)
      ) {
        autoJams.push({ lon: d.loc.coordinates[0], lat: d.loc.coordinates[1], ts });
      }
    }
    pruneRecentReports();
    pruneAutoJams();
    if (recentReports.length) console.log(`[replay] rehydrated ${recentReports.length} report(s) from Mongo`);
  } catch (e) {
    console.warn("report rehydrate skipped:", e.message);
  }
}

// ---------- graceful shutdown ----------
// Railway and Render send SIGTERM before replacing a container on every deploy.
// Without a handler the process is SIGKILLed after a grace period: open sockets
// die mid-frame and any distance still buffered in a connection's pendingKm is
// silently lost. Closing the WS server first sends a proper close frame, so the
// app's existing reconnect-with-backoff kicks in cleanly against the new
// instance instead of waiting for a TCP timeout.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — shutting down`);

  for (const ws of wss.clients) {
    try {
      ws.close(1001, "server restarting"); // 1001 = going away
    } catch {
      /* already gone */
    }
  }
  wss.close();

  server.close(() => {
    mongoose.connection
      .close(false)
      .catch(() => {})
      .finally(() => {
        console.log("shutdown complete");
        process.exit(0);
      });
  });

  // Hard cap: platforms only wait ~10-30s before SIGKILL, so never hang past it.
  setTimeout(() => {
    console.warn("forced exit — connections did not close in time");
    process.exit(0);
  }, Number(process.env.SHUTDOWN_TIMEOUT_MS || 8000)).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// A crash inside a fire-and-forget promise would otherwise take the whole
// process down on Node 15+. Log and keep serving: every DB write in this file
// is already best-effort, so losing one is not worth dropping every driver.
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason instanceof Error ? reason.message : reason);
});

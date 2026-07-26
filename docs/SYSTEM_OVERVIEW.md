# Tiberias Nav — System Overview (Baseline)

How the system works, end to end, as of the completed simulation phase. Three
independent parts — a Python pipeline, a Node server, an Expo app — meet in two
places: a MongoDB database and a WebSocket.

One correction to keep in mind throughout: **the app does not calculate
off-route distance. The server does.** The phone is deliberately a thin
client — it streams raw GPS and displays whatever verdict comes back. That
keeps the geometry math in one place (one source of truth, tunable without an
app release) and sets up Phase 2, where the same check moves into an indexed
MongoDB query.

---

## 1. The route: from OpenStreetMap into MongoDB

`geo-pipeline/extract_route_90.py` runs once (and re-runs whenever you want
fresher geometry).

1. It queries the Overpass API with a union of two selectors, both clipped to
   the Tiberias bounding box: ways tagged `ref=90` directly, plus member ways
   of the Route 90 road *relation* (this second selector is what recovers city
   stretches where segments carry the relation but not their own ref tag). The
   request sends a `User-Agent` header because Overpass rejects anonymous
   clients with 406.
2. The returned way segments are merged with `shapely.linemerge`. Where Route
   90 is dual-carriageway, merging yields multiple strands; the script logs
   the count and takes the longest strand as the PoC centerline.
3. Geometry is reprojected to the Israel TM Grid (EPSG:2039) so math happens
   in real meters, and a ±30 m buffer polygon is built around the centerline
   (simplified, counter-clockwise-oriented — the ring winding MongoDB
   expects). Everything is reprojected back to WGS84 for storage.
4. Two artifacts come out: `hwy90_tiberias.geojson` on disk (a
   FeatureCollection of centerline + buffer, for eyeballing at geojson.io
   before trusting it), and an upsert into MongoDB's `routes` collection —
   one document holding the slug `hwy90-tiberias`, the centerline as a
   GeoJSON LineString, the buffer Polygon, and `lengthM`. Both geometry
   fields carry 2dsphere indexes. The buffer isn't used yet: it is the
   pre-seeded fast path for Phase 2's `$geoIntersects` check.

GeoJSON axis order is `[lon, lat]` everywhere. It is the number-one
geospatial bug class, and every layer of this system assumes it.

## 2. The server: one process, two doors

`server/server.js` is a single Node process exposing HTTP and WebSocket on the
same port (3000).

**Boot.** Mongoose connects, then `loadRoute()` reads the `hwy90-tiberias`
document and caches a Turf `lineString` in memory — the hot path never touches
the database for geometry. If the route isn't seeded yet, the server starts
anyway in log-only mode and retries loading lazily whenever a client connects,
so seed order doesn't matter.

**HTTP door.** Three routes: `GET /health` (liveness + whether the route is
loaded), `GET /routes/hwy90-tiberias` (the GeoJSON Feature the app draws), and
a `POST /ping` signpost that answers 426 with the correct WebSocket address —
telemetry is intentionally not REST.

**WebSocket door — `/track`.** Every incoming message runs a five-stage
pipeline:

1. Parse and validate: `lon` and `lat` must be numeric.
2. Glitch filter: using the last *accepted* fix of this connection, compute
   the implied speed of the jump. Above 70 m/s (~250 km/h) the fix is
   physically implausible — GPS teleport — and is rejected with a
   `{type:"rejected"}` frame. Rejected fixes do not update the reference
   point, so the filter recovers on the next honest fix.
3. On-route check: one call to `turf.nearestPointOnLine(line, point,
   {units:"meters"})` returns both the perpendicular distance to the
   centerline (`dist`) and the position along it (`location`). `onRoute` is
   simply `dist <= 30`. (Cross-validated against the EPSG:2039 Shapely math
   to within half a meter.)
4. Persist: the ping is written to `location_pings` — GeoJSON Point, speed,
   heading, accuracy, the verdict (`onRoute`, `distanceM`, `progressM`),
   a 2dsphere index, and a 7-day TTL index so the PoC never hoards data.
5. Respond: `{type:"status", onRoute, distanceM, progressM, progressPct}` is
   pushed back on the same socket, and a `[ping]` line goes to the console —
   those lines are the field-test dataset.

`progressM` (meters along the route) is the quiet star: bucketing pings by
progress is how average segment speed — the traffic layer — gets computed in
Phase 2.

## 3. The app: sensors in, pixels out

`mobile_app/` is an Expo (SDK 57) project using expo-router; the single route
`app/index.tsx` mounts `components/MapScreen.tsx`, which owns everything.

**Startup guard.** Before rendering, MapScreen verifies the installed
`@maplibre/maplibre-react-native` actually exposes the v11 API (`Map`,
`GeoJSONSource`, `Layer`, ...). If not, instead of the classic "Element type
is invalid" crash it renders a self-diagnosing screen that prints the live
exports and names which generation is installed (v9 / v10 / empty) with the
exact fix. This exists because the package renamed its API twice.

**Finding the server.** `lib/serverHost.ts` resolves `host:port` through four
layers, first hit wins: (0) a runtime override — tapping the status card opens
an editor; (1) `EXPO_PUBLIC_SERVER_HOST`, baked at bundle time (`.env` for
local builds, `eas.json` `env` for EAS cloud builds, which never see a
gitignored `.env`); (2) automatic detection of the Metro bundler host from
`expo-constants` — in a dev-client build served by `npx expo start`, this is
the dev PC's *current* LAN IP, which is why local development needs no
configuration even when the router reassigns addresses; (3) `localhost`, valid
only for emulators. The HUD always displays which host won.

**Route line.** The app fetches `GET /routes/hwy90-tiberias` at mount and
retries on every socket reconnect until it lands — so app-before-server startup
order also doesn't matter.

**Real GPS.** `expo-location`'s `watchPositionAsync` runs at
`BestForNavigation` accuracy, emitting a fix every ~2 s / 5 m. Each fix does
two things: updates local state (HUD speed/accuracy, camera tracking) and is
serialized into a telemetry ping `{deviceId, lon, lat, speed, heading,
accuracy, ts}`.

**The socket.** Pings go out over a WebSocket with exponential-backoff
reconnect (1 s doubling to 15 s) and an offline queue: when the link is down,
up to 500 pings buffer in memory and flush on reconnect, so brief dropouts
lose nothing. Incoming `status` frames update the verdict state.

**Rendering.** The MapLibre `Map` loads the OpenFreeMap "liberty" vector
style — which already includes 3D building extrusions, visible at the current
camera pitch of 45°. On top of it: a `GeoJSONSource` holding the route Feature
with two line `Layer`s (a dark wide casing under a saturated blue line — the
classic navigation road treatment), and the native `UserLocation` puck with
heading and accuracy ring. The `Camera` starts on Tiberias and switches to
`trackUserLocation="heading"` after the first fix.

**Feedback.** The verdict drives two surfaces: the HUD pill (state label,
distance to centerline, percent along the corridor, plus a telemetry strip)
and a full-screen border — green on-route, red off — readable at a glance
while driving. Tapping the HUD opens the server-host editor.

## 4. The simulator (what "simulation phase" actually ran)

`server/simulate_ping.js` is not part of the app and is not wired into
anything — it is simply *another WebSocket client*, run on the PC. It fetches
the real route from the server, samples it every 15 m with `turf.along`,
"drives" at ~54 km/h with GPS-like jitter, ramps ~84 m off-route mid-drive and
back, and prints every status reply. Its pings carry `deviceId: "simulator"`,
so its rows are distinguishable from the phone's (`poc-…`) in both the console
and MongoDB. The phone's GPS pipeline runs identically and independently —
they can even run at the same time.

## 5. One ping's journey (the whole system in ten steps)

1. The GPS chip produces a fix; `watchPositionAsync` delivers it to MapScreen.
2. MapScreen updates the HUD/camera and serializes the ping.
3. The ping leaves over `ws://<resolved-host>:3000/track` (or queues if the
   link is down).
4. The server parses and validates it.
5. The glitch filter compares it to the previous accepted fix.
6. `nearestPointOnLine` measures distance-to-centerline and progress.
7. The verdict + ping are written to `location_pings` (TTL 7 days).
8. A `[ping]` line hits the server console; a `status` frame returns on the
   socket.
9. MapScreen updates the pill and flips the border green or red.
10. Two seconds later, the next fix repeats the loop.

## 6. Phase 3 — dynamic routing

A long-press anywhere on the map sends `{type:"set_destination", deviceId,
destination:[lon,lat], origin?}` up the same socket. The app stays a thin
client: it names the destination and immediately renders a pin; everything
else is server-side.

The server resolves the origin (the connection's last accepted fix, falling
back to the `origin` the app attached), queries OSRM
(`/route/v1/driving/...?geometries=geojson&overview=full`, with a User-Agent
and a 15 s timeout), validates the response, and builds a Turf line from the
returned LineString. The result is stored **per device** — never globally —
so one phone's destination cannot change what the simulator or a second
device is judged against. Entries live in a deviceId-keyed map with a 6-hour
idle TTL, which also means a route survives the app's routine socket
reconnects: on the first ping after a reconnect the server rebinds the stored
route and re-pushes it so the app resyncs automatically.

The verdict engine did not change — `checkOnRoute` simply receives the active
route (dynamic if set, else the Highway 90 baseline, else none), and every
status frame and persisted ping now names which route judged it
(`route: "dynamic" | "hwy90-tiberias"`). A routing failure (no road,
OSRM down) returns `{type:"route_error"}` and never clobbers the currently
active route. Dynamic routing works even in log-only mode — it has no MongoDB
dependency at all.

## 7. Phase 4 — search and the reroute reflex

**Search.** The search bar sends `{type:"set_destination", deviceId,
query:"free text", origin?}` — the *same protocol verb* as the long-press,
with `query` instead of `destination`. The server geocodes the text through
Nominatim (`/search?format=jsonv2&limit=1`, with the identifying User-Agent
its usage policy requires — one reason geocoding lives server-side), then
feeds the resolved point into the exact OSRM flow. `new_route` frames now
carry `destination` and `destinationName`, so the app drops the pin at the
*resolved* location and shows the place name. "No results" returns
`route_error` and, as always, never clobbers the active route.

**Auto-reroute.** The Waze reflex runs server-side, inside the verdict loop:
while a dynamic route is active, consecutive `onRoute:false` verdicts
increment a per-connection streak (any on-route verdict resets it). At three,
the server fires a fresh OSRM query from the *current fix* to the *stored
destination* — asynchronously, so status frames are never delayed — pushes
`{type:"new_route", rerouted:true}`, and resets the streak. A 15 s cooldown
and an in-flight guard prevent hammering OSRM while stuck off-road. The app's
only involvement is rendering the new line and posting "rerouted: X km".

The HUD also stopped hardcoding "Route 90": every status frame names its
judge (`route`), and the labels follow it.

## 8. Phase 5 — structured autocomplete

Typing in the search bar sends `{type:"search_suggest", query}` after a 500 ms
debounce and a 3-character minimum; the server answers
`{type:"suggestions", query, items:[{name, detail, lon, lat}]}` — each item
formatted from Nominatim's `addressdetails` (street + house number, locality),
biased toward the Tiberias area and labeled Hebrew-first. The app shows the
dropdown under the search bar and guards against stale answers by echoing the
query. Tapping a suggestion routes **by coordinates** through the normal
`set_destination` flow (with the display name attached) — no second geocode
ever fires.

The policy problem this design solves: the public Nominatim server forbids
raw search-as-you-type and bans violators. All geocoder traffic therefore
funnels through a server-side global gate (≥1.1 s between calls — the policy's
hard limit), and a 10-minute query cache absorbs repeats and backspacing.
Verified live: repeat queries answer in single-digit milliseconds with zero
geocoder hits; uncached calls space themselves ~1.1 s apart. For production,
`NOMINATIM_URL` points at a self-hosted instance or a commercial geocoder and
the same code simply runs faster.

## 9. Phase 6 — the navigation camera

The camera is now driven imperatively (`CameraRef.easeTo`/`flyTo` on every GPS
fix) instead of the declarative tracker, in three modes. **follow** (no route):
gentle north-up tracking at zoom 15.5 / pitch 45. **nav** (dynamic route
active): the windshield view — zoom 17, pitch 60, and course-up rotation, with
the bearing taken from GPS heading only while actually moving (>0.8 m/s), held
steady while stationary so the map doesn't spin at red lights. Any new dynamic
route — tap, search, or auto-reroute — flies the camera into nav mode.
**free**: a finger on the map pauses everything; the `userInteraction` flag on
region-change events cleanly separates gestures from our own animations, and a
floating crosshairs button appears to snap back (to nav if a route is active,
follow otherwise).

Search latency also dropped in this phase: the Nominatim gate now supports
supersession — a burst of keystrokes collapses to at most two real geocoder
calls (verified: 5 keystrokes → 2 hits, newest query answers) instead of each
stale query burning a 1.1 s slot. The rate limit itself is unchanged.

## 10. Phase 7 — turn-by-turn maneuvers and route arrows

The OSRM request now includes `steps=true`. When a dynamic route is built, the
server pins every maneuver to its position **along the line** (meters from
start, via `nearestPointOnLine`) and sorts them. Because each ping already
computes `progressM`, "distance to the next turn" is then pure subtraction —
`alongM - progressM` — needing no extra geometry per ping and no client math.
Every status frame carries the next maneuver ahead of the driver
(`{type, modifier, name, exit, distanceM}`) or null once past the last turn.

The app renders two things from this. A high-visibility **maneuver banner**
replaces the search bar during active navigation: a large turn glyph
(↰ ↱ ↻ ⚑ derived from the modifier/type), the distance in rounded 10 m / km
steps, and the instruction ("Turn left onto Sderot Herzl"). It updates every
ping and reverts to the search bar when no maneuver is pending. On the map, a
**symbol layer** places white chevrons along the route line
(`symbol-placement:"line"`, map-aligned, upright disabled) so the direction of
travel reads directly off the asphalt.

## 11. Phase 7b — premium aesthetic (field-corrected) and voice

Two field failures taught this section its final shape. The OpenFreeMap
"dark" style turned out to be an incomplete, abandoned upstream fork (their
own repo says so) and rendered near-black on-device — the basemap is
**liberty**, the maintained style, verified readable in the field; a true dark
navigation look means a keyed provider or a Maputnik-customized liberty. And
symbol layers **must name their font**: the route arrows originally omitted
`text-font`, so MapLibre requested its default Open Sans/Arial Unicode stack
from a server that only carries Noto Sans — glyph-range 404s, invisible
arrows. They now use `"text-font": ["Noto Sans Regular"]` with a `»` chevron
from the always-served 0–255 glyph range.

What stands: the green→cyan **gradient carpet** (`line-gradient` over
`line-progress`, `lineMetrics:true`), glow/casing/core layering, chevrons,
translucent-glass maneuver card, speed pill, and voice. The user puck is the
**native course arrow** (`NativeUserLocation mode="course"`, 30 fps) — a
GPS-heading navigation arrow with no accuracy halo, replacing the JS puck
whose accuracy circle swallowed the screen at urban GPS precision.

Honest limitation, unchanged: a literally tapering "carpet" (width scaling
along the line) is not expressible with MapLibre line layers; the gradient
plus the 60° pitch approximates it.

Voice guidance uses `expo-speech`: each turn announced twice — an early
heads-up ("In 300 meters, turn left onto Sderot Herzl") and a close cue under
60 m ("Turn left now") — keyed on maneuver identity so nothing repeats per
ping, `Speech.stop()` before each utterance, a mute toggle on the card, and
cleanup on unmount. Adding expo-speech (a native module) requires a native
rebuild; a JS reload cannot supply it.

## 12. Phase 8 — GPS status awareness and UI cleanup

Field debugging revealed the "wrong street" jumps were GPS hardware
(jamming / poor urban reception), not route logic — the server's glitch filter
was already rejecting the teleport pings; the app just never told the user why
the arrow drifted. Now it does, Waze-style: a fix with `accuracy` worse than
50 m, or no fresh fix within 8 s (tracked by a 2 s heartbeat so a *stopped*
GPS feed is also caught), raises a dark-amber "No GPS — showing approximate
location" banner. Threshold logic is unit-tested across good/jammed/stale/
no-fix cases.

The UI was rebuilt for clarity. The full-width debug panel that covered the
middle of the map is gone — connection state and speed/accuracy now live in a
small bottom-right chip. Off-route no longer paints a full-screen border or a
big panel; it folds into the maneuver card ("Recalculating… — N m off route"
with a ⟳ glyph) plus a thin 4 px top strip. The top stack was lowered so it
clears the map compass. Navigation camera pitch was pushed to 78° at zoom 17.5
for the carpet-to-horizon look.

## 13. Phase 9 — the pre-drive flow (search pill + route preview)

The app gained an explicit `NavPhase` state machine (`idle → preview →
driving`) layered over the existing routing engine — wrapping it, not
replacing it. Previously a `new_route` frame flowed straight into navigation;
now the two are decoupled. A **fresh** route (from the search pill or a
long-press) enters **preview**: the camera pulls back to fit the whole route's
bounds (`CameraRef.fitBounds` at pitch 0), and a bottom card slides up showing
trip time, arrival ETA (now + `durationS`), and distance — all read from
`feature.properties`, already on the wire, so nothing server-side changed. A
big **GO** button leaves preview and triggers what used to happen
automatically: the smooth fly into the 78° carpet, voice, and the maneuver
card. Cancel drops the route back to idle.

The reroute path is preserved by branching on phase: a `rerouted` frame, or
any `new_route` that arrives while already `driving`, updates the live line
silently instead of bouncing the driver back to preview. Voice is gated to the
`driving` phase so the preview is silent. The search bar became a persistent
"Where to?" pill (icon, clear button, autocomplete dropdown), and navigation
chrome (maneuver card, speed pill, re-center, status chip) is now shown only
in its relevant phase. Branch table and ETA/distance/bounds formatters are
unit-tested.

Day/night automation was intentionally deferred: OpenFreeMap's dark style is
unusable, so a true dark mode waits on a keyed provider (MapTiler) in a later
phase — the basemap stays liberty for now.

## 14. Phase 9b — Hebrew voice guidance

Voice guidance was localized to Hebrew — a **client-only** change, which the
architecture already made possible. OSRM's route API has no `language`
parameter (text is compiled separately by `osrm-text-instructions`), and our
voice sentences were never OSRM's text — they're built in MapScreen from the
structured maneuver fields. So Hebrew is purely a matter of translating that
sentence builder and switching the TTS locale; `server.js` needed no change
(and adding `&language=he` to OSRM would have been a silent no-op).

`maneuverLabel`/`maneuverSpeech` now emit Hebrew with correct RTL grammar
(verb-then-direction: "פנה שמאלה", roundabout exits, ramps, merges, arrival,
distance phrases like "בעוד 300 מטר"), and `Speech.speak` uses `language:
"he-IL"` at a slightly slower rate for clarity. The maneuver card's own status
strings ("מחשב מסלול מחדש…", "מנווט…") were Hebraized to match. Phrasing is
unit-tested across maneuver types. Note: OSRM street `name` values come from
OSM and are often already Hebrew in Tiberias, but where a street is tagged only
in English the name will be spoken as-is — a data limitation, not a code one.

## 15. Phase 10 — bottom-UI safe area, camera hardening, full RTL, Waze voice timing

Four field-driven fixes, all in MapScreen. **Safe area:** the speed pill (and
status chip, re-center button, preview card) clipped off the bottom and
collided with the MapLibre logo; they now offset by `useSafeAreaInsets()`
(expo-router already provides the `SafeAreaProvider`), device-agnostic rather
than a magic margin. The pill shows Hebrew "קמ״ש" with a larger centered
number. **Camera:** the 78° pitch could drift flat — not from a tracker (that
was removed in Phase 6) but from ease interruptions and bearing wobble.
`driveCamera` now always sends the full `{center,zoom,pitch,bearing}` tuple in
nav mode, eases in 600 ms (settling before the next ~2 s ping), and smooths
bearing along the shortest arc so a noisy heading can't spin the view. **RTL:**
the maneuver card is `row-reverse` with right-aligned text (glyph on the
right), and all remaining UI strings are Hebrew (search "חפש יעד", end "סיום",
preview "ביטול"/"יציאה", GPS banner, distance unit "מ׳"). Applied per-component,
not via app-wide `I18nManager.forceRTL`, so LTR elements (speed digits) aren't
flipped. **Voice:** replaced the on-appearance announcement with Waze-style
distance staging — an advance cue when the turn first enters 400 m and an
action cue under 50 m, each tracked per maneuver so a ping stream never
repeats a cue. Unit-tested 9/9 across approach, chained turns, arrival, and
re-entry.

## 16. Phase 10 — Waze-style UI shell (screenshot-matched)

A visual re-architecture of the idle experience, routing logic / phase machine
/ 78° camera / Hebrew phrasing all untouched. Refined against real Waze
screenshots, which corrected the initial blind build's biggest miss: **Waze's
idle shell is a light theme**, not dark. So the idle surfaces (bottom sheet,
FABs, menu, preview card) now use a white/light-gray token set, while the
*driving* overlays (maneuver glass card, speed pill, GPS banner) keep the dark
palette that reads correctly over the map.

Idle layout matching the screenshots: a white **bottom sheet** with grip
handle, a light-gray "לאן?" search pill (mic left, magnifier right), and
Home/Work/Saved quick-action cards; autocomplete results replace the quick
actions while typing, styled as light list rows. A white **menu tile** with a
red notification dot sits top-left; **white circular FABs** (layers, sound)
top-right; a **yellow rounded-square report tile** mid-right. The **preview
card** is white with a large duration headline, muted distance, and a blue
"לצאת עכשיו" action button with a darker trailing accent segment beside a
secondary cancel — sharing the sheet's bottom anchor so it slides up in place.
Shell actions remain stubbed to a "בקרוב" notice. All logic tests still pass.

**Keyboard handling.** The bottom sheet is `position:absolute, bottom:0`, so
the system keyboard slid over the search input. A `KeyboardAvoidingView` can't
lift an absolutely-positioned child, so instead the sheet subscribes to
keyboard show/hide events (`keyboardWillShow/Hide` on iOS,
`keyboardDidShow/Hide` on Android) and offsets its `bottom` by the reported
keyboard height — lifting it clear while keeping it out of the map/camera
layout entirely (78° view untouched). The sheet carries an explicit `zIndex`
so its touch zone sits above the native map, and the suggestion list is a
height-capped `ScrollView` with `keyboardShouldPersistTaps="handled"` so rows
stay tappable with the keyboard open and never run off-screen. Offset logic is
unit-tested across open/closed/varying-height.

## 17. Phase 11 — professional iconography, real-location init, GPS-banner & voice hardening

Four production-polish fixes, keeping the light theme, keyboard offset, and all
logic. **Icons:** every emoji glyph (search, mic, menu, hazard, home, volume,
turn arrows, etc.) was replaced with `@expo/vector-icons` Ionicons — glyph
names verified against the installed glyphmap, dead glyph styles removed.
**Real-location init:** the camera no longer opens on the Highway-90 default;
on mount a fast `getCurrentPositionAsync` (Balanced) centers the map on the
user's actual position via `CameraRef.jumpTo`, with a `didCenterRef` guard so
the first watch fix also covers the case where the quick fix fails.
**GPS-banner false positive:** the warning is now hidden by default and gated
on `!permissionDenied`, with thresholds relaxed to genuine signal loss (65 m /
12 s) and age computed from `Date.now()` (heartbeat still drives re-render) so
a fix is never falsely flagged stale between ticks — unit-tested to stay hidden
for normal urban fixes and only appear on real loss. **Voice** was already
correct (advance cue ≤400 m, action cue ≤50 m, per-maneuver dedupe); left
intact and reconfirmed. Adding `@expo/vector-icons` is a JS dep but ships its
fonts with Expo, so no native rebuild is required for a dev client that already
has the Expo runtime; a fresh standalone build will bundle the fonts.

## 18. Phase 12 — standalone speedometer, over-speed alert, render isolation

The speed pill became a **standalone memoized `Speedometer` component**,
visible in both idle (above the bottom sheet) and driving (above the safe
area). It shows km/h (converted from `expo-location` speed in m/s) and turns a
bold red fill/border when speed exceeds `SPEED_LIMIT_KMH` (default 90).

The render-optimization is the substantive part. The GPS stream calls `setFix`
every ~2 s, which re-renders MapScreenInner; previously the speed display was
derived inline there. Now speed lives in its own state updated only when the
**rounded km/h actually changes** (guarded by a ref), and the `Speedometer` is
`React.memo`'d — so a speed change repaints only the pill, and identical
consecutive readings don't repaint anything. The map layers and bottom sheet
no longer churn on the location stream. Unit-tested: same-speed fixes produce a
single update, m/s→km/h is exact (25 m/s = 90 km/h), speed-lost updates to
null, and the alert flips precisely above the limit.

Course-up rotation (#3 in the request) was already implemented in Phase 6/10
(`driveCamera` extracts `heading`, smooths it along the shortest arc, applies
it as camera `bearing`) and was left untouched. The keyboard offset, z-indexes,
touch persistency, Ionicons, and TTS voice logic are all unchanged.

## 19. Phase 13 — traffic report menu (frontend)

The orange report FAB now opens a **report menu** — a light-theme bottom sheet
(`Modal transparent animationType="slide"`) with a header/close button and a
2×2 grid of the four core Waze reports: Police (משטרה), Accident (תאונה),
Hazard (מפגע), Traffic Jam (פקק), each a colored Ionicons circle with a Hebrew
label. Tapping an option `console.log`s "Report submitted: {type}" and closes
the menu; the backdrop is tap-to-dismiss (with tap-inside propagation stopped)
and there's an explicit close button. Backend wiring is deferred — this is the
UI and the local action only.

Purely additive: a new `reportOpen` state, a `submitReport` callback, the
`REPORT_OPTIONS` table, one rewired FAB `onPress`, and the modal. The
Speedometer/alert, keyboard offset, sheet z-index, touch persistency, GPS,
course-up, and voice logic were all verified unchanged.

## 20. Phase 14 — idle-shell discovery UI (categories + recent searches)

The idle bottom sheet gained a Waze-style discovery layer, shown before the
user types (autocomplete still replaces it while typing). Below the search bar:
the Home/Work/Saved quick row, then a horizontally scrolling row of **category
chips** (Food/Gas/Emergency/Saved — Ionicons, `keyboardShouldPersistTaps` so a
chip registers with the keyboard open), then a **recent-searches list** (static
placeholder rows with a clock icon; tapping one drops its text into the search
field — real plumbing via `onQueryChange`). The top-right FAB stack was changed
to **music (top) + voice/sound (bottom)**, the latter still the working
turn-by-turn mute. All new elements render only in `phase === "idle"` and match
the light-theme sheet styling.

Purely additive to the render tree. The memoized Speedometer + speed-alert, the
keyboard-offset logic (+ sheet z-index and touch persistency), and the Phase 13
report menu were all verified unchanged.

## 21. Phase 15 — real-time traffic reports (backend + wiring)

Reports flow over the **existing** socket — no second server, no new port, no
new dependencies (`ws` was already installed). The report menu's tap now sends
`{type:"traffic_report", deviceId, reportType, location:[lon,lat]}` through
`sendJson`, which means the offline queue applies: a report tapped in a dead
zone delivers on reconnect. `server.js` gained one handler block in the same
message router: it whitelists the four report types, enforces a 5 s
per-connection cooldown (every accepted report fans out to every client, so
the endpoint is an amplification vector), validates the location (falling back
to the device's last ping position), persists fire-and-forget to a new
`traffic_reports` collection (2dsphere + **1-hour TTL** so stale reports
self-expire), then broadcasts to every *other* open client and acks the
sender. The client surfaces incoming broadcasts as a Hebrew notice ("דיווח
חדש בקרבת מקום: פקק"), acks as "הדיווח התקבל", and errors verbatim.
`simulate_report.js` fires test reports without a second phone. Verified by an
11/11 live integration test against the running server: broadcast fanout,
no-echo-to-sender, cooldown, unknown-type rejection, no-location rejection,
and ping-position fallback — with Mongo absent, proving persistence never
blocks the broadcast. Known limits, deliberately deferred: notices render only
in the idle sheet (driving-phase report pins on the map are the natural next
step), and late joiners don't receive recent history (a replay-on-connect from
the TTL'd collection).

## 22. Phase 16 — auto dark mode (merged)

Merged the frontend developer's auto dark mode into the reporting build — a
true two-branch merge: his branch had the theming but predated the Phase 15
socket reporting; ours had reporting but no theming. Base = our socket
version; his delta applied on top, so nothing from either side was lost
(verified by marker audit: all socket handlers, offline queue, Hebrew notices
AND all theme machinery present; tsc clean).

His architecture, kept intact: night = 18:00–05:59 local, computed per render
(the 2 s telemetry re-render lands the flip within seconds of the boundary);
`theme` (LIGHT/DARK) feeds a `makeStyles(t)` factory rebuilt via useMemo only
when the mode flips; the basemap swaps between OpenFreeMap liberty (day) and
**CARTO dark-matter** (night — OpenFreeMap's own dark is the abandoned
near-black fork, Phase 7 finding). The Speedometer and setup screen moved to
**static stylesheets** so a theme flip can never re-render the memoized pill.
The dark driving HUD (maneuver glass, status chip) deliberately doesn't
re-theme — it already sits correctly over both basemaps. Only the idle shell
re-skins: sheet, FABs, menu tile, preview card, report menu, all via the
Theme tokens.

One risk in his version was verified and closed: the route chevrons request
the `"Noto Sans Regular"` glyph fontstack, and CARTO is a different glyph
provider than OpenFreeMap. Fetched CARTO's live dark-matter style JSON —
"Noto Sans Regular" appears inside its own layers' fontstacks, so the font
exists on their glyph server and the chevrons survive the day/night swap
unchanged (comment in-code updated from caveat to verified fact).

## 23. Phase 17 — category POI search (backend, Overpass)

Server-only feature powering the category chips (Food/Gas/Emergency). New
`category_search` message on the existing socket: `{type:"category_search",
category, lat, lon}` → the server maps the category to an OSM tag regex, queries
**Overpass** (`around:radius,lat,lon` over node/way/relation with `out center`
so ways resolve to coordinates), parses to a clean minimal array (drops unnamed
POIs, resolves centers, computes haversine distance, sorts nearest-first, caps
at 15), and returns `{type:"category_results", category, items:[{name, detail,
lon, lat, distanceM}]}` to the requester only — not a broadcast. Overpass is a
separate endpoint from Nominatim with its own rate policy, so it got its own
serialize-with-1.5s-spacing gate rather than sharing the geocoder's chain.
Location falls back to the device's last ping if the client omits lat/lon;
unknown category and no-location return an error field with an empty list.
`OVERPASS_URL`/radius/spacing are env-overridable (point at a self-hosted
instance for production). `simulate_category.js` tests it without the app.
Verified: 12/12 parser unit tests (mixed node/way payloads, Hebrew names,
unnamed-drop, distance sort) and a 12/12 live integration test that also
confirms the **traffic-report broadcast still works alongside** the new handler,
and that category results go only to the requester. Telemetry, geocoding, and
reports untouched.

## 24. Phase 18 — replay on connect (backend)

The moment a client connects, the server now replays the active traffic reports
so a late joiner instantly sees current road hazards — like a real nav app.
Design decision: replay is served from an **in-memory window** (`recentReports`,
oldest-first), NOT a per-connect Mongo query. The architecture treats Mongo as
optional (pings/reports are fire-and-forget; the socket must never hang or die
with the DB), so a replay that awaited Mongo on every connect would break that
contract. Mongo's 1-hour TTL index remains the durable cleanup; the in-memory
window (same 60-min horizon, `REPORT_TTL_MS`) is the fast, always-available
replay source. `pruneRecentReports()` drops anything older than the TTL on every
write and before every replay, so stale hazards never linger or reach a new
client. Each accepted report is pushed to the window next to its Mongo persist;
each replayed frame is marked **`replay:true`** so the client can render it
silently as existing state instead of firing a "new hazard ahead" alert for old
news (live broadcasts stay unflagged). On startup, `rehydrateRecentReports()`
best-effort refills the window from recent persisted reports so a restart
doesn't blank active hazards. Boot also changed: Mongo failure now logs and
continues (the WS server already listens independently) rather than
`process.exit(1)`, matching the fire-and-forget principle the replay design
relies on. Verified: 7/7 live integration (empty-server no replay, late joiner
gets full history as replay:true, oldest-first order, live alert stays
unflagged, newest joiner sees all active) run with **Mongo absent** to prove
memory-only replay, plus 6/6 TTL-prune unit tests (expired dropped, boundary
exact, all-expired empties). The frontend must consume `replay:true` to render
history silently — deferred to the frontend team.

## 25. Phase 19 — OSRM routing throttle

Audit-and-fix rather than a new feature. The dynamic routing engine
(`set_destination` → OSRM → `RouteFeature` → `new_route`, with `route_error`
handling and multi-leg step flattening) has existed since Phase 3 and is what
the app already uses for every long-press and search-result route; the only
"hardcoded" route is the Highway-90 fallback seed served before a destination
is set. The one genuine gap: `fetchOsrmRoute` called the public OSRM with no
throttle, while Nominatim (suggest) and Overpass (category) both had
serialize-with-spacing gates. Since routing also fires on server-side
auto-reroute, unthrottled OSRM was actually the likeliest of the three to burst
the public server. Added `osrmSlot()` — same gate pattern as the other two,
own chain, `OSRM_MIN_GAP_MS` (default 600ms) — and routed `fetchOsrmRoute`
through it, so both call sites (manual set_destination and auto-reroute) are
covered by one change. Nothing else touched. Verified: 9/9 parser + feature-
shape + error-path unit tests, and a 6/6 live integration test that confirms
`new_route` still returns a correct LineString feature with durationS/distanceM,
impossible routes still return `route_error`, and 4 back-to-back routing
requests now hit OSRM spaced ≥600ms apart (vs. simultaneously before).

## 26. Phase 20 — persistent search history (backend)

Makes the idle-shell "recent searches" list real instead of placeholder. New
`SearchHistory` Mongoose model (`deviceId`, `name`, `lon`, `lat`, `ts`) in the
`search_history` collection, with a compound `(deviceId, ts desc)` index so
"latest N for this device" is a cheap query, plus a 90-day TTL so it stays
bounded. Two integration points: (1) persist — when `set_destination` resolves
to a route AND has a real `destinationName` (a routed suggestion or geocode,
not a bare-coordinate long-press), a fire-and-forget `recordSearch()` saves it,
same `.catch`-and-continue contract as ping/report writes. (2) fetch — a new
`get_recent_searches` handler returns the top 5 UNIQUE-by-name destinations,
most-recent first, via an aggregation (`$match` device → `$sort` ts → `$group`
by name keeping `$first` → `$sort` → `$limit 5` → `$project` name/lon/lat), so
re-routing to the same place bumps it to the top rather than duplicating it.

Requirement-4 (Mongo optional) is the careful part: writes are fire-and-forget,
but the fetch is request/response, so it can't `await` a query that would hang
or throw when the DB is down. A `mongoReady()` guard (`readyState === 1`) makes
the handler return an empty list immediately if Mongo isn't connected, and the
aggregation's own `.catch` returns empty on any query error — the client just
shows its placeholder, nothing hangs or crashes. Verified: 8/8 aggregation-
semantics tests (dedup by name, recency ordering, 5-cap, device isolation,
projection shape — the real mongod binary wasn't reachable from the build
sandbox, so the pipeline stages were validated by faithful reimplementation),
plus 6/6 live WS integration with **Mongo deliberately down** proving routing
still works, the persist attempt doesn't crash, and `get_recent_searches`
returns `[]` immediately rather than hanging. All prior systems intact. The
frontend still needs to send `get_recent_searches` and render
`recent_searches_results` — deferred to the frontend team.

## 27. Phase 21 — V2X proximity alerts (backend)

The server now actively warns a driver when they approach an active report,
rather than only broadcasting reports at creation/connect. On each telemetry
ping (after glitch-rejection, so the fix is trustworthy), a spatial scan checks
the driver against the in-memory `recentReports` window and sends a targeted
`{type:"proximity_alert", reportId, reportType, distanceMeters, message}` for
any active report within `PROXIMITY_RADIUS_M` (default 500m). Reuses the
existing `haversineM` (Phase 17) and the `recentReports` window (Phase 18) — no
new data source.

The two performance requirements drove the design. (1) Per-connection scan
throttle (`PROXIMITY_SCAN_MIN_GAP_MS`, default 4s): telemetry arriving faster
than that skips the scan entirely, so a 2s ping stream doesn't re-scan every
ping. (2) The scan itself is cheap — the window is already pruned to the last
60 min, and a bounding-box pre-filter (degree deltas from a metres-to-degrees
constant, longitude scaled by cos(lat)) rejects far-away reports with
subtractions before any haversine runs (unit-tested: a driver 90km away
triggers zero trig calls). Re-alert dedup is a Map keyed `deviceId|reportId`
with a 15-min cooldown (`PROXIMITY_REALERT_MS`), swept opportunistically when it
grows past 1000 entries so it stays bounded. All thresholds are env-tunable.

Verified: 11/11 unit tests (threshold geometry, per-device dedup + isolation,
15-min re-alert window, bbox-reject efficiency, at-threshold boundary) and 9/9
live integration — a driver pinging 200m from a report gets the alert, a fast
re-ping is throttled (no duplicate), a 90km-away driver gets nothing, and report
broadcast / routing / telemetry-verdict all keep working alongside. The frontend
must render `proximity_alert` (a heads-up cue distinct from the idle "new report
nearby" notice) — deferred to the frontend team.

## 28. Phase 29 — field fixes: anti-jitter reroute, vehicle profiles, clear history

Three field-driven changes. Nothing in the 3D camera (pitch 80), `mapStyle.ts`,
`laneGeometry.ts` or `laneAssist.ts` was touched — those three lib files are
byte-identical to the previous build (md5-verified).

**1. Anti-jitter off-route (critical).** Field report: a +/-112 m fix in a
parking lot produced an endless "rerouted" loop. Root cause is false precision —
a flat 30 m corridor is meaningless when the position itself is uncertain by
112 m, so a parked car "wanders" off-route, and every reroute is then computed
from a garbage origin, so it never converges. The decision lives server-side
(the client only renders `m.rerouted`), so the fix is in `server.js`, in three
layers: a JITTER GATE (`isJitterSuspect`) that refuses to judge at all when the
driver is crawling (< 10 km/h, or unknown speed) AND the fix is poor (> 40 m);
an ACCURACY-AWARE CORRIDOR (`offRouteToleranceM`) that widens the corridor by
the fix's own error radius, capped at 120 m; and a START GRACE that adds 80 m
for the first 90 s of a route, so a driver can leave an unmapped car park and
reach the road network without the app panicking. When the gate fires the
verdict is held at on-route so the HUD never flashes "recalculating" at a parked
car, and the ping log gains `tol=` and `JITTER(...)` fields for field debugging.
All thresholds are env-tunable. Verified 20/20 unit + live integration: six
consecutive +/-112 m stationary pings trigger zero reroutes, while a driver
genuinely departing the route with a good fix still reroutes on `offStreak=3`.

**2. Vehicle profiles (car / motorcycle / walking).** VERIFIED and contrary to
the original spec: an `osrm-routed` process serves exactly ONE profile and never
validates the `{profile}` path segment, so `router.project-osrm.org` answers
`/route/v1/foot/` and `/route/v1/bike/` with the same CAR route. Selecting a
vehicle by editing that path segment ships a feature that silently lies. The
real multi-profile service is FOSSGIS at `routing.openstreetmap.de`, which runs
three separate worldwide engines chosen by a HOST PREFIX — `routed-car`,
`routed-bike`, `routed-foot` — with the path segment left as `driving`. That is
now the contract (`OSRM_BASE_URL` + `OSRM_PROFILE_ENGINE`). The OSRM throttle
also moved 600 ms -> 1100 ms because the FOSSGIS policy is an explicit max of
1 req/s (600 ms was in breach). The profile rides on `set_destination`, is
stored on the route entry, and is re-used by auto-reroute so a walking route
cannot silently become a driving route mid-trip; unknown values fall back to car
rather than erroring. Motorcycle maps to the bike engine per spec, with
`MOTORCYCLE_PROFILE=car` as a one-env-flip alternative (see the caveat in the
code comment: the bike engine prefers cycle paths and returns ~15 km/h ETAs).
Client: a segmented control in the route preview (rechev / ofnoa / halicha),
which re-asks the server for the same trip on the new engine so the stats always
describe the highlighted vehicle.

**3. Clear search history.** The recent list is SERVER-side (Mongo
`SearchHistory`, keyed by deviceId, Phase 20) — NOT AsyncStorage, which holds
only the device identity the gamification profile depends on. Clearing
AsyncStorage would have left the history intact and destroyed the user's
points/rank. New `clear_search_history` message, scoped strictly to the caller's
own deviceId, with the same Mongo-down guard as the read path. The client clears
its list immediately for instant feedback and treats the server's empty
`recent_searches_results` as confirmation; a failed delete reports an error
rather than showing a cleared state that did not persist.

Known pre-existing issue, untouched: `tsc` reports one error where
`mapStyle.ts`'s `StyleJson` type is not assignable to MapLibre's
`StyleSpecification`. It exists identically in the previous build (line 2062
there, 2128 here) and is a type-level looseness only; this phase adds zero new
type errors.

## 29. Phase 30 — search keyboard collapse (field fix)

Field bug: tapping "לאן?" opened the keyboard for a split second, then the
sheet collapsed, in a loop. The supplied diagnosis (re-render churn unmounting
the input) was verified WRONG before any code changed: no inline component
definitions, the TextInput sits at a stable tree position, and
keyboardShouldPersistTaps was already correct on all three lists. The real
cause was a DOUBLED OFFSET: Android's default windowSoftInputMode is
adjustResize, so the OS already shrinks the window above the keyboard — and
the JS then lifted the bottom sheet AGAIN by the full keyboard height,
dragging the search row off the top of the shrunken viewport (sheet top −212pt
on a 900pt screen). Focus lost → keyboard closed → offset reset → oscillation.
Fix: `KEYBOARD_LIFTS_SHEET = Platform.OS === "ios"` — the lift is genuinely
needed on iOS (overlay keyboard) and must never run on Android. 10/10
layout-math tests (new sheet top +134pt, constant across keyboard toggles, so
oscillation is structurally impossible). Bonus hardening: the search row is a
module-level memoized `SearchBar` with a stable clear callback, so telemetry
re-renders (several per second while driving) no longer touch the input.
Watch-out recorded in app.json terms: if `softwareKeyboardLayoutMode: "pan"`
is ever set, this platform split must be revisited.

## 30. Phase 34 — signal clustering + synthesis, crowd validation, z-order, glass UI

Four workstreams, one honesty contract.

**Stop-line clustering (server).** Overpass returns one `traffic_signals`
node per stop line, so a four-way junction arrives as 4–8 nodes metres apart
and rendered as an unreadable pile. `clusterSignals()` greedily merges nodes
within `SIGNAL_CLUSTER_M` (30m) into one icon at the incremental centroid,
with a stable id (lowest member id) and a `count` of merged stop lines.

**Traffic-light synthesiser (server).** OSM signal tagging is volunteer-made
and patchy; an untagged junction is indistinguishable from an unsignalised
one, and a blank major intersection reads as a broken feature. Where the
route makes a genuine junction maneuver (`turn`/`fork`/`end of road`/`new
name` with a non-straight modifier — ramps, merges, roundabouts and
depart/arrive excluded) AND the road evidence at that point (from the SAME
corridor lookup the lane synthesiser uses, at zero extra Overpass cost) shows
a major class or ≥2 lanes, AND no real signal sits within
`SIGNAL_SYNTH_DEDUP_M` (60m), a signal is injected flagged `inferred:true`.
Everything inferred is LABELLED: dimmer glow + muted ring on the map, and the
countdown card says "רמזור משוער" instead of "הערכה". Estimates are useful;
they are never dressed as surveyed fact. Pipeline: cluster → synthesise →
send; the `[corridor]` log shows `N raw -> K clustered + M inferred`.

**Crowd validation (both ends).** Every active report (live or replayed) is
now a map pin (GPU layers, REPORT_OPTIONS colours, ASCII "!" mark). Tapping a
pin — same two-detector hit-test as driver taps — opens the "עדיין שם?" glass
popup: 👍 refreshes confidence, 👎 counts toward retirement. Server:
`vote_report` {reportId, vote:"up"|"down"}, one vote per device per report
(duplicates ack `counted:false`), and at net `REPORT_RETIRE_SCORE` (−2) the
report is spliced from the replay window and `report_removed` is broadcast to
every client, closing any open popup for it. Known limitation, recorded
honestly: the wire report id is not the Mongo `_id`, so the best-effort
durable delete is a no-op in practice — the 1h TTL remains the durable
cleanup for persisted reports.

**Z-order fix (client).** MapLibre stacks layers by NATIVE ADD ORDER, not JSX
order. The maneuver beam, turn point, 3D beacon and lane carriageway all
mount MID-DRIVE — later than the signal icons — so they landed on top and
buried the lights at exactly the junction the driver was looking at. Fix:
explicit ordering props (verified against the installed v11 `Layer.d.ts`:
`beforeId` "appear under", `afterId` "appear above"). Signal layers are
pinned `afterId="route90-arrows"` (anchor provably mounted whenever signals
render); beam/point/beacon pin to the same anchor so they sit above the route
but under the earlier-mounted signals under adjacent-insert semantics; lane
layers get `beforeId="route90-glow"`, fixing the latent carriageway-above-
ribbon inversion too. Honest caveat: the JS side forwards these props
straight to native, so the documented contract is the guarantee; the
signals-above-beam refinement additionally assumes adjacent insertion, and in
the rare race where the driver reaches a turn before Overpass answers, the
beam can sit above that route's signals.

**Glass UI.** One shared surface for everything floating over the map:
`C.glass` rgba(20,25,40,0.85) + hairline `glassBorder` + soft deep shadows —
applied to the FABs, menu button, live pill, recenter, status chip and
maneuver banner; sheet and preview card get rounder corners and softer
shadows. `expo-blur` was deliberately NOT added: it is a native module and
would force a full rebuild for every developer for what the translucent fill
already achieves. Icons over glass switched to `glassText`.

Tests: 20/20 unit (clustering geometry, synthesiser rules incl. all negative
cases) and 13/13 live integration (real server, stub OSRM/Overpass: 4 raw →
1 clustered + 1 inferred end-to-end, full vote lifecycle incl. idempotency,
retirement, all-client removal, late-vote rejection).

## 31. Phase 35 — synthesiser density pass + on-road lane arrows

**Synthesiser density (server).** Field feedback: far too few inferred lights
in Tiberias. The supplied diagnosis ("restricted to strictly primary roads")
was verified WRONG — secondary/tertiary were already admitted. The real
starvers were three: (1) the >=2-lane requirement excluded every single-lane
street, which is most of the old town; (2) a silent geometry bug — probes sit
every 250m, so a turn can legitimately be ~125m from its nearest probe, but
`SIGNAL_SYNTH_MATCH_M` was 120m, orphaning exactly those turns whatever the
road class; (3) the 60m dedup merged distinct close junctions. Explicit
product call applied: over-index for visual density. New rules: any genuine
turn on ANY real street qualifies (only `service` ways and no-match excluded;
lane count no longer gates); "continue" with a hard left/right now counts
(OSRM emits it when your road bends through an intersection — slight variants
stay excluded as mere curvature); match ceiling 200m; dedup 40m so junctions
40-60m apart each get a light while anything under the 30m cluster radius
still reads as one. Roundabouts remain excluded — they are by definition
unsignalised; that's a fact, not caution. The honest-labelling contract
(`inferred:true` → dimmer icon + "משוער") is what makes over-indexing safe.
15/15 unit tests on the new rule matrix; 13/13 live integration re-run.

**On-road lane arrows (client).** The Gaode/Baidu ground-paint signature:
one directional arrow per lane, stamped flat on the synthesized asphalt in
two rows (25m and 60m) before the junction, each rotated by that lane's
indication using the SAME `LANE_ARROW_ROTATION` table as the HUD — road and
HUD can never disagree. New pure module `lib/laneArrows.ts` (the protected
laneGeometry/laneAssist stay byte-identical); 13/13 geometry unit tests run
against the real module. Deliberate deviation from the requested
symbol-layer approach, for verified reasons: real arrow glyphs (U+2190+)
sit outside the 0-255 glyph range both basemaps serve (the Phase 2/28
finding that forced "»" chevrons), so `text-field` cannot draw them; v11
does export an `Images` component, but the project ships no sprite assets
and raster icons billboard-scale rather than behave as ground area. Fill
polygons ARE ground paint — map geometry that foreshortens correctly at the
80° pitch with no alignment props at all. Arrows use real thermoplastic
proportions (~4.2m), valid lanes glow near-white and others dim (mirroring
the HUD), fade in with the carriageway above ~z16.5, and are pinned
`afterId="route90-arrows"` — above the ribbon, beneath the earlier-pinned
signal lights, consistent with the Phase 34 ordering scheme.

## Phase 49 — field fixes: MapLibre expression crash, keyboard, corridor width

**1. MapLibre JNI crash (`interpolate`/`step`).** Four paint properties nested
a zoom ramp inside a multiply: `["*", ["interpolate",...,["zoom"],...], f]`.
MapLibre requires `["zoom"]` to be the input of a TOP-LEVEL `step`/
`interpolate`; nested, native rejects the ENTIRE property and logs the JNI
error every frame. Sites: `lane-divider-lines` line-opacity,
`lane-corridor-glow`, `lane-corridor-core` and `lane-corridor-chevrons`
fill-opacity. Fixed by hoisting the zoom ramp to top level and moving the
per-feature factor into its top stop — algebraically identical (a 0→K ramp
times F equals a ramp 0→K·F), so the visuals are unchanged. Note the
suspected cause (`routeYield`, the dynamic camera) was NOT involved:
`yieldTo()` returns plain JS numbers, and `line-gradient` was already a
correct top-level interpolate on `["line-progress"]`.

Because tsc cannot see malformed style expressions and no JS test exercises
them, this class of bug reaches the device every time. `tools/
check_map_expressions.py` now walks every paint/layout value with bracket-
depth tracking and fails on any `["zoom"]` that isn't a direct child of a
top-level step/interpolate. Verified BOTH ways: it flags all four original
sites and passes the fixed tree. Run it before every release.

**2. Keyboard covering the search field.** The Phase 30 fix
(`KEYBOARD_LIFTS_SHEET = Platform.OS === "ios"`) was correct when written —
Android's adjustResize really did shrink the window, so lifting in JS as well
double-offset the sheet. That contract is now void: this app targets Expo SDK
57 / RN 0.86, and from Android 15 (targetSdk 35) edge-to-edge is FORCED, under
which adjustResize no longer resizes the window at all — the system hands the
app an IME inset and expects it to react. Nothing lifted the sheet, so the
keyboard covered the input, with no JS change to blame. The lift now runs on
both platforms. KeyboardAvoidingView (the usual advice, and what the report
suggested) would not have helped: it cannot lift an absolutely-positioned
child, which is exactly why the manual keyboardH path exists. The Phase 30
doubled offset cannot return unless edge-to-edge is disabled, which Android
15+ does not permit.

**3. Lane corridor width and multi-lane legibility.** The ribbon spanned the
full 3.6m lane, so its edge landed on the white divider and painted over it
(the corridor draws above the divider layers) — a solid green block replacing
the lane rather than a glowing path inside it. Two changes in
`lib/laneCorridor.ts`: a new `coreInsetM` (0.4m per side) narrows the ribbon
to 2.8m inside a 3.6m lane, leaving the divider and a strip of raw asphalt
visible down both sides; and the corridor now emits ONE RIBBON PER VALID LANE
instead of one per contiguous run, so two adjacent valid lanes no longer merge
into a single 7.2m slab with the shared divider buried underneath. 3.6m
remains the lane width everywhere (asphalt, arrow spacing, corridor) — only
the highlight is inset. Supporting invariants: the glow pad is clamped to the
inset so the halo can never re-cover the divider, and the chevron width is
derived from the ribbon (2.3m calibrated against a full-lane corridor would
have run up to the rim; it now resolves to ~2.0m). `coreInsetM: 0` restores
the previous full-lane look, so the calibration stays tunable rather than
hardcoded. 17/17 geometry tests on the real module, including the 2-adjacent-
lane and 5-lane cases.


## Phase 50 — signal card overlap, ribbon vs corridor, thinner ribbon, history delete

**1. Signal card hidden under the top banner.** `guidanceGroupH` was
`GUIDANCE_BANNER_H (92) + LANE_BOX_H (76)` — arithmetic on two estimates. Once
Phase 48 unified the banner and lane box into one shell the real height stopped
matching, and it was always going to: the banner wraps long Hebrew street names
to a second line, font scaling moves it, and the lane box grows with lane count.
No fixed number is right for every junction. The group is now MEASURED with
`onLayout` and the card positions off that; the constants survive only as the
first-frame fallback, and the measurement is dropped whenever the group's
content changes (`laneAssistVisible`, `phase`) so a stale value can't show a
too-low card for a frame.

**2. Blue ribbon vs green corridor.** Both were painted on the same asphalt and
the blue bled around the (now much thinner) green. Phase 41 had answered this by
collapsing the WHOLE ribbon to a hairline, and its own comment named the cost:
that answers "which lane" at the expense of "where next". Hiding the layer
outright (`line-opacity: 0`) pays that cost in full — at 80° pitch the route
beyond the turn is most of the screen. The fix uses the fact that line-opacity is
per-layer but **line-gradient is per-position**, and the route source already
sets `lineMetrics`: new `lib/routeGradient.ts` builds each ribbon layer's
gradient with a transparent hole across exactly the corridor's span
(`corridorHole()` maps route length + remaining + maneuver distance into
line-progress, capped at the corridor's own 250m). Blue disappears precisely
where green replaces it; everywhere else the ribbon is back at FULL width and
opacity, including past the junction. The hole's alpha rides the same routeYield
ramp, so it fades in with distance rather than snapping on. Stops are quantised
to 0.1% of route length to avoid re-uploading a gradient texture every GPS fix.
Chevrons already faded to 0 at full yield and still do — the corridor carries its
own. 31/31 unit tests, including the boundary cases (a hole touching t=0 or t=1
originally produced a non-increasing stop list, which MapLibre rejects outright —
i.e. the Phase 49 crash class, caught by test before it could ship).

**3. Thinner ribbon.** `coreInsetM` 0.4 → 0.65: a 2.3m ribbon inside a 3.6m lane,
0.65m of raw asphalt and the full white divider clear on each side. Derived
values follow automatically — the glow clamps to the inset so the halo still
can't reach the divider, and chevrons rescale to 1.66m. 17/17 geometry tests
re-run at the new width, including 2-adjacent-lane and 5-lane cases.

**4. Long-press to delete one recent search.** The list is SERVER-side (there is
no local array to splice), so this is a new `delete_search_history_item` handler
scoped strictly to the caller's deviceId. It matches on NAME because that is what
the read path groups by — one visible row IS all rows sharing that name — and it
re-runs the read path's aggregate verbatim so the client gets the authoritative
list back and the two can never drift. With Mongo down it returns
`recent_searches_error` rather than a fake empty list, and the client surfaces
that instead of dropping a row that would reappear. Client side: `onLongPress`
on each recent row → `Alert` "מחק מהיסטוריית חיפושים?" → confirm.

**5. Expression sweep.** The Phase 49 fix is intact; no nested `["zoom"]`
remains anywhere. `tools/check_map_expressions.py` now also validates that every
`line-gradient` is itself a top-level step/interpolate — the same MapLibre rule,
a second way to hit the same crash — and is verified both ways (it flags a
deliberately malformed gradient and passes the real tree). Note the remaining
toast in the screenshots could not be diagnosed from the truncated text
`[Mbgl] {RenderT...}`; everything statically checkable is clean, so if it
persists please capture the full line.

Also declared `@maplibre/maplibre-gl-style-spec` as a devDependency: the
`ExpressionSpecification` type import previously resolved only by npm hoisting
it out of maplibre-react-native.


## Phase 51 — lane guidance on the wrong side of the road

Field report from a Phase 48 build: the green corridor rendered in the ONCOMING
lane. Items 2-4 of the same report (blue ribbon fighting the corridor, signal
card hidden under the banner, long-press delete) were already fixed in Phase 50
and needed no further work — the device was running an older build.

**Root cause.** Every lane builder here centres its output on the line it is
handed, which is correct only when that line is the CARRIAGEWAY centre. The
server was already right: `lanesForWay` returns a per-direction count, halving
`lanes` on a two-way way and honouring `lanes:forward`. But it computed `oneway`
purely as a local variable and never sent it, so the client had a correct count
with no idea which half of the road it occupied. On a oneway way the OSM
geometry IS the carriageway centre; on an ordinary two-way street it is the ROAD
centre, so centring the forward lanes on it laid half of them across the centre
line. A left turn selects the LEFTMOST forward lane — which put the highlighted
corridor squarely in oncoming traffic. Exactly what the screenshot showed.

**Fix.** `isOnewayWay(tags)` is factored out of `lanesForWay` and the flag now
rides in every `route_lanes` sample (`oneway:false` on a no-match, the safer
default: assuming two-way offsets us onto the right-hand side, where a driver
actually is, whereas assuming oneway straddles the centre line). Client side,
`carriagewayOffsetM(lanes, oneway, laneWidthM)` returns the signed shift from
the way's centreline to ours — expressed through a `RIGHT_HAND_TRAFFIC`
constant rather than a bare minus sign, so the assumption is visible and
invertible for a left-driving country.

The shift is applied to the CENTRELINE, once, rather than threaded through
three builders: `buildCarriageway` offsets each span before building, and
`drivingSlice` offsets the maneuver slice that feeds both the arrows and the
corridor. Because all three consume an already-shifted line, they agree by
construction — the same guarantee the modules' headers claim about lane width.
`nearestSample` was factored out of `lanesAt` so the lane count and the
direction flag always come from the SAME sampled way; resolving them
independently would let a span combine one way's count with a neighbour's
direction. `LaneSpan` gained `oneway` and the span seam splits on it, so a
oneway/two-way transition mid-route is handled rather than smeared.

The maneuver BEAM was moved onto the same shifted line. It is a 26px cyan
glow drawn down the centreline, so correcting only the corridor would have left
it straddling the centre line — re-creating the reported bug in a different
colour. The shift is derived from the physical sample at the junction rather
than from laneAssist's lane count, deliberately: the beam appears at 900m and
laneAssist only at 400m, so two sources would slide the beam sideways by half a
carriageway the moment lane guidance arrived. Where the two counts disagree the
error is at most half a lane, against a guaranteed visible jump on every
approach. The maneuver POINT and 3D beacon stay on the centreline — they mark
the junction itself, not a lane.

17/17 new geometry tests, including an explicit before/after assertion that the
corridor moves from left-of-centreline (the bug) to entirely right of it, that
a left turn lands on the lane adjacent to the centre line and a right turn on
the kerb-side lane, and that oneway carriageways are left exactly as they were.
Full suite re-run green: 17 corridor, 31 gradient, 13 arrows, 13 server
integration, expression guard clean.


## Phase 52 — the drive-side shift was coupled to Overpass

**1. Corridor still on the wrong side — the real cause.** Phase 51's geometry
was correct in isolation (its 17 tests still pass), but `carriagewayShiftM`
returned **0** whenever `laneSamples` was empty or nothing matched. That is not
an edge case: `fetchRouteCorridor` returns `EMPTY_CORRIDOR` every time the
Overpass breaker is open, which is exactly the coupling
`inferredTrafficLights.js` was written to break for the lights in Phase 36. The
same mistake had been reintroduced one module over — and its failure mode was
not "no lane guidance", it was "lane guidance on the wrong side of the road",
which is worse than none. The shift now degrades to an ASSUMPTION rather than
to nothing: unknown direction means two-way (matching the server's own default,
and putting us on the right-hand carriageway where a driver actually is), and
the lane count falls back through the sample → laneAssist → LANE_COUNT_FALLBACK.
9 new tests cover the outage path specifically, asserting a right turn lands on
the kerb-side lane and a left turn adjacent to the centre line with NO sample
data at all.

**2. Blue ribbon guaranteed gone.** The Phase 50 per-segment hole is still the
good path — it hides the ribbon exactly where the corridor covers it and keeps
the route beyond the turn visible. But it needs route length and remaining
distance, and when either is missing `corridorHole` returns null and the ribbon
stayed fully visible beside the green. `ribbonFullyHidden` now forces every
route90 layer to opacity 0 when the corridor is up and no hole could be
computed. Chevrons became binary on `laneCorridor` rather than riding the yield
ramp: the corridor paints its own chevrons inside the ribbon, so route chevrons
over that stretch are pure clutter. They now vanish when the corridor appears
(400m) instead of fading out by 250m — a deliberate, visible trade for the
clutter the field report called out twice.

**3. Signal cycle retuned.** 75s cycle, 30s green / 45s red (was 60s / 32s
green), which reads as a plausible urban junction where red is the longer half.
Verified the countdown never reports 0 or a negative. Worth recording: the
cycle math is CLIENT-side in `signalPhase`, not in `inferredTrafficLights.js` —
that module decides WHERE inferred lights go, not when they change. It is still
a simulation and still labelled "משוער" everywhere it appears; no municipal
feed exists for Tiberias.

**4. Build identity.** Two consecutive field reports described bugs already
fixed in a build that hadn't been flashed. `BUILD_TAG` is now logged to the
Metro console on mount and sent in a `hello` frame the server logs on connect,
so confirming the running build takes one second instead of a round trip.


## Phase 53 — the chevrons were never route90-arrows

**1. Blue chevrons: wrong layer, twice.** Phases 50 and 52 both hid
`route90-arrows`, and both times the chevrons came back. They were
`maneuver-beam-arrows` — a symbol layer drawing "»" at
`0.75 + pulseWave * 0.25` with no yield term of any kind, so nothing done to
the route ribbon ever touched it. Phase 51 made it materially worse by moving
the beam onto `drivingSlice`, the same line the corridor uses, which planted
those chevrons directly on the green ribbon where they fought its own white
ones. The whole beam is now unmounted while the corridor exists (`!laneCorridor
&&`): the 26px cyan glow and its chevrons are two answers to the question the
corridor answers better. Verified nothing external anchors to the beam layers —
its two `afterId`s are internal to its own chain, so it unmounts cleanly.
`route90-arrows` stays MOUNTED at opacity 0 because six layers use it as a
z-anchor.

`tools/check_chevron_clutter.py` now enforces the invariant structurally: every
LINE-PLACED "»" layer must be either opacity-gated on `laneCorridor` or
unmounted by it. Scoped to line placement deliberately — `drivers-heading` uses
the same glyph as a point marker on another car's dot and is a different
feature. Verified both ways: passes the real tree, and flags
`maneuver-beam-arrows` the moment the mount gate is removed. tsc cannot see
this class of bug and no runtime test exercises it, which is precisely how it
survived three review rounds.

**2. Lateral offset: a real straddle, from a count mismatch.** The sign was NOT
inverted — tests measure real coordinates and confirm a negative offset moves
east, i.e. right of northbound travel. The bug was that Phase 52 derived the
shift from the physical OSM sample while the corridor draws `laneAssist`'s lane
array, and the two disagree whenever OSRM `turn:lanes` reports 2 lanes and the
OSM `lanes` tag (or its default) says 1. Shifting 1.8m while drawing a 2-lane
array leaves it spanning -1.15m..+1.15m — straddling the centre line with its
left lane in oncoming traffic. The shift now derives from `laneAssist.lanes.length`
first, so it is always half the width of the array actually rendered. The
reason Phase 52 preferred the sample (avoiding a beam jump at 400m) no longer
applies, because the beam is now hidden once the corridor appears.

**3. Crisp dashed dividers.** They were `beforeId="route90-glow"`, i.e. beneath
a 22px glow and 15px casing running down the centreline, which buried the
innermost dividers exactly where the driver looks. Lifted to
`afterId="route90-arrows"`, above the whole route stack. The corridor cannot
cover them — it is inset 0.65m per side and its glow clamps to that inset,
leaving 0.4m of clearance to each lane boundary. Restyled to read as real road
marking: width 0.8/2.6/6 across z16-20 (was 0.6/2/5), opacity 0.95 surveyed /
0.6 inferred (was 0.7/0.385), dash 2:2 in line-widths (was 2.5:3.5, whose long
gaps dissolved at speed).


---

*Baseline through Phase 53. Natural next steps: heading-aware proximity
alerts, and the traffic layer from `progressM`.*

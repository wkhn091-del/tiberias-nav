// MapScreen.tsx — Phase 1: Route 90 Tiberias PoC
// MapLibre map + OSM-seeded route layer + GPS watcher + telemetry WebSocket.
// Targets @maplibre/maplibre-react-native v11 (Map / GeoJSONSource / Layer API).
//
// Location: mobile_app/components/MapScreen.tsx — mounted by app/index.tsx.
//
// Host resolution is automatic (see config below). Expo dev builds allow
// cleartext ws:// — production must move to wss://.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Alert,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Location from "expo-location";
import * as Speech from "expo-speech";
import { isUsingLocalhostFallback, normalizeHostInput, wsBase } from "../lib/serverHost";
// Phase 56: every backend address in the app resolves through lib/config.
// SERVER_HOST is the startup default; the runtime override box below can still
// replace it, which is why wsBase() is still imported for the live value.
import { IS_CLOUD_TARGET, SERVER_HOST, SERVER_PORT } from "../lib/config";
import { loadOrCreateDeviceId } from "../lib/deviceId";
import { loadStyle, type StyleJson } from "../lib/mapStyle";
import {
  carriagewayOffsetM,
  nearestSample,
  buildCarriageway,
  circlePolygon,
  crossbarPolygon,
  headingOf,
  routeAhead,
  splitByLanes,
  drivingCentreline,
  lanesAt,
  speedLimitAt,
  type LaneSample,
} from "../lib/laneGeometry";
import { resolveLaneAssist, mapLanesOntoCarriageway } from "../lib/laneAssist";
import { gradientWithHole, corridorHole, ROUTE_RAMP } from "../lib/routeGradient";
import type { ExpressionSpecification } from "@maplibre/maplibre-gl-style-spec";
import { buildLaneArrows } from "../lib/laneArrows";
import { buildLaneCorridor } from "../lib/laneCorridor";
import {
  Camera,
  GeoJSONSource,
  Layer,
  Map as MapLibreMap,
  NativeUserLocation,
  type CameraRef,
  type PressEvent,
  type ViewStateChangeEvent,
} from "@maplibre/maplibre-react-native";
// Namespace import used ONLY by the setup-error screen to self-diagnose which
// generation of the package is installed (v9 namespace / v10 named / v11 named).
import * as MapLibreNS from "@maplibre/maplibre-react-native";

// ---------- config ----------
// Server host resolution lives in ../lib/serverHost.ts (unit-tested). Order:
//   0. runtime override — tap the status card, type host:port (session only)
//   1. EXPO_PUBLIC_SERVER_HOST — baked at build time (.env locally, eas.json
//      "env" for EAS); required for standalone APKs that have no Metro
//   2. Metro bundler host from expo-constants — the automatic local-dev path;
//      served by `expo start`, so the dev PC's current LAN IP resolves itself
//   3. localhost fallback (emulator + adb reverse only)
// Phase 56: the port is no longer declared here. It lived in FOUR files
// (server.js, serverHost.ts, this one, set_server_ip.js) with a comment in each
// asking the next reader to keep them in step — which is how it drifted twice
// already. lib/config.ts re-exports the single declaration; see the import above.
// Basemaps (Phase 16 auto day/night). Light = OpenFreeMap liberty — proven
// readable on-device, includes 3D building extrusions. Dark = CARTO
// dark-matter, a maintained keyless dark GL style. OpenFreeMap's own "dark"
// is an abandoned fork that renders near-black in the field (Phase 7
// finding), so the night half comes from CARTO instead.
const MAP_STYLE_LIGHT = "https://tiles.openfreemap.org/styles/liberty";
const MAP_STYLE_DARK = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
const TIBERIAS_CENTER: [number, number] = [35.5395, 32.79];
const PING_INTERVAL_MS = 2000;
// Device identity is PERSISTED (see lib/deviceId.ts) and loaded before this
// screen mounts — it arrives as a prop on MapScreenInner. It used to be a
// module-level `Math.random()`, which silently reset the driver's gamification
// profile and search history on every app launch.
// GPS quality: accuracy worse than this (meters) or no fix within the stale
// window means we warn the user it's a satellite issue, like Waze does.
// ADVISORY ONLY — these thresholds drive a banner and nothing else. No fix is
// ever discarded, delayed or altered because of them. Deliberately forgiving:
// an indoor Wi-Fi fix is routinely 50-150m, and warning about that during
// development is noise, not signal.
const POOR_ACCURACY_M = 200;  // real signal loss; indoor Wi-Fi is 50-150m
const STALE_FIX_MS = 30000;   // no fresh fix for 15x the ping interval
// Phase 44. Backstop threshold used ONLY when OSM gives us no limit for the
// current stretch. The regulatory SIGN and the WARNING have different truth
// requirements and are treated differently on purpose: the sign asserts a legal
// fact and is therefore shown only when we actually know it, while the warning
// is advisory, so a coarse backstop is better than no protection at all on an
// unmapped road. Set to null to disable warnings entirely where the limit is
// unknown.
const SPEED_LIMIT_FALLBACK_KMH: number | null = 90;
// GPS speed carries a couple of km/h of noise, and a HUD that cries wolf at
// limit+1 trains the driver to ignore it — which costs more safety than it buys.
// This is a measurement-noise allowance, not a licence: at 2 km/h you are still
// effectively at the limit. Set to 0 for a strict comparison.
const SPEED_TOLERANCE_KMH = 2;

// ---------- types ----------
type RouteFeature = {
  type: "Feature";
  properties: { name?: string; lengthM?: number; distanceM?: number; durationS?: number };
  geometry: { type: "LineString"; coordinates: [number, number][] };
};

type Suggestion = { name: string; detail: string; lon: number; lat: number };

// The pre-drive flow: idle (search only) -> preview (route shown, ETA card,
// awaiting GO) -> driving (78° carpet, voice, maneuver card). Distinct from
// cameraMode, which is about who controls the camera within a phase.
type NavPhase = "idle" | "preview" | "driving";

// follow = north-up gentle tracking (no route) · nav = tilted course-up
// navigation view (route active) · free = user panned, camera hands-off
type CameraMode = "follow" | "nav" | "free";

// One lane at an upcoming junction, from OSRM's intersection data. Ordered
// left-to-right as the driver faces the turn. `valid` = usable for THIS
// maneuver, which is what the HUD highlights.
// Mirrors the shape in lib/laneAssist.ts — OSRM's layout, also produced by the
// synthesiser, so the HUD renders both through one path.
type TurnLane = { valid: boolean; indications: string[] };

type Maneuver = {
  type?: string;
  modifier?: string | null;
  name?: string | null;
  exit?: number | null;
  distanceM: number;
  /**
   * Phase 47: metres from the route start to this maneuver. Constant for a
   * given maneuver across every ping, which makes it the only field safe to
   * IDENTIFY a maneuver by — see maneuverKey.
   */
  alongM?: number | null;
  /** null where OSM has no turn:lanes tagging for the junction. */
  lanes?: TurnLane[] | null;
};

type RouteStatus = {
  onRoute: boolean | null;
  distanceM: number | null;
  progressPct: number | null;
  /** Phase 46: metres still to drive. null = no route / not computable. */
  remainingM: number | null;
  /**
   * Phase 46: seconds still to drive, interpolated server-side from OSRM's
   * per-step durations — NOT the total scaled by progress. null when the server
   * has no duration profile, in which case the dashboard hides the figure
   * rather than showing an invented one.
   */
  remainingS: number | null;
  route: string | null; // which route judged us: "dynamic" | "hwy90-tiberias"
  maneuver: Maneuver | null; // next turn on the dynamic route
};

// ---------- maneuver presentation ----------
// Ionicons names for turn directions (verified present in the glyphmap).
type IoniconName = React.ComponentProps<typeof Ionicons>["name"];

// ---------- vehicle profiles (Phase 29) ----------
// The wire value is English and stable (the server maps it to an OSRM engine);
// only the label is Hebrew, matching the RTL shell. Icons verified against the
// Ionicons glyphmap. Order is RTL-first: car is the default and sits rightmost.
type VehicleProfile = "car" | "motorcycle" | "foot";
const VEHICLE_OPTIONS: { key: VehicleProfile; label: string; icon: IoniconName }[] = [
  { key: "car", label: "רכב", icon: "car-sport" },
  { key: "motorcycle", label: "אופנוע", icon: "bicycle" },
  { key: "foot", label: "הליכה", icon: "walk" },
];
/**
 * Turn geometry as an ANGLE, not as a separate icon per direction.
 *
 * PHASE 45. The old MODIFIER_ICON table collapsed seven distinct maneuvers into
 * three glyphs: "slight left" and "slight right" both resolved to arrow-up,
 * making a gentle bend indistinguishable from carrying straight on, and
 * "sharp left" rendered identically to an ordinary left. Ionicons has no
 * slight/sharp arrow variants, so rather than approximate with the wrong glyph
 * we rotate ONE arrow to the real angle — which is what a rendered arrow is for,
 * and how the ground arrows in laneArrows.ts already work.
 *
 * Angles are clockwise-positive, matching LANE_ARROW_ROTATION so the banner and
 * the painted road arrows lean the same way for the same maneuver.
 */
const MODIFIER_ANGLE: Record<string, number> = {
  straight: 0,
  "slight right": 35,
  right: 90,
  "sharp right": 135,
  "slight left": -35,
  left: -90,
  "sharp left": -135,
};

type ManeuverGlyphSpec = { name: IoniconName; rotate: number };

function maneuverIcon(m: Maneuver): ManeuverGlyphSpec {
  const t = (m.type ?? "").toLowerCase();
  const mod = (m.modifier ?? "").toLowerCase();

  if (t === "arrive") return { name: "flag", rotate: 0 };
  if (t.includes("roundabout") || t.includes("rotary")) return { name: "sync", rotate: 0 };
  // A dedicated U-turn glyph reads faster than an arrow spun 180 degrees, which
  // at a glance is ambiguous with "straight".
  if (mod === "uturn") return { name: "return-up-back", rotate: 0 };

  // Slip roads get a CURVED arrow — the nearest thing Ionicons has to the
  // sweeping ramp glyph commercial apps use, and enough to distinguish "leave
  // the carriageway" from "turn at a junction" without reading the text.
  if (t === "on ramp" || t === "off ramp" || t === "ramp") {
    return { name: mod.includes("left") ? "arrow-undo" : "arrow-redo", rotate: 0 };
  }

  return { name: "arrow-up", rotate: MODIFIER_ANGLE[mod] ?? 0 };
}

/**
 * The banner's turn glyph. Split into its own memoized component so the
 * rotation transform stays out of the render body, and so the distance text
 * updating on every fix doesn't rebuild the icon.
 */
const ManeuverGlyph = React.memo(function ManeuverGlyph({
  maneuver,
  size,
}: {
  maneuver: Maneuver;
  size: number;
}) {
  const g = maneuverIcon(maneuver);
  return (
    <Ionicons
      name={g.name}
      size={size}
      color={C.routeCore}
      style={g.rotate !== 0 ? { transform: [{ rotate: `${g.rotate}deg` }] } : undefined}
    />
  );
});

/**
 * A single character for the on-map turn marker.
 *
 * ASCII only, deliberately. Map glyphs come from the basemap's font server and
 * only range 0-255 is reliably present on both providers — the same constraint
 * that forced the route chevrons to use "»". Arrow characters like ← ↑ → live
 * in range 8192-8447 and would render as empty boxes on one or both basemaps.
 * The Ionicon in the maneuver card carries the precise turn direction; this is
 * just a legible marker on the road itself.
 */
function maneuverArrowGlyph(m: Maneuver | null): string {
  const t = m?.type ?? "";
  if (t === "arrive") return "X"; // destination cross-hair
  const mod = m?.modifier ?? "";
  if (mod.includes("left")) return "<";
  if (mod.includes("right")) return ">";
  if (mod === "uturn") return "U";
  return "^";
}

// Phase 13: traffic report options (Hebrew labels, verified Ionicons).
const REPORT_OPTIONS: { type: string; label: string; icon: IoniconName; color: string }[] = [
  { type: "Police", label: "משטרה", icon: "shield", color: "#2D6BFF" },
  { type: "Accident", label: "תאונה", icon: "car-sport", color: "#EF4444" },
  { type: "Hazard", label: "מפגע", icon: "warning", color: "#F59E0B" },
  { type: "Traffic Jam", label: "פקק", icon: "car", color: "#8B5CF6" },
];

// Phase 14: idle-shell discovery UI. Category chips + recent searches are shown
// in the bottom sheet before the user types. Recent data is a static
// placeholder until real search history is persisted. Icons are Ionicons
// (glyph names verified); labels Hebrew to match the RTL shell.
// `key` MUST match the server's CATEGORY_FILTERS keys exactly — the server
// rejects anything else with {error:"unknown category"}. Only these three are
// backed (Overpass, Phase 17); the old "saved" chip had no backend and is gone.
const SEARCH_CATEGORIES: { key: string; label: string; icon: IoniconName; color: string }[] = [
  { key: "food", label: "אוכל", icon: "restaurant", color: "#F97316" },
  { key: "gas", label: "דלק", icon: "car", color: "#10B981" },
  { key: "emergency", label: "חירום", icon: "medkit", color: "#EF4444" },
];

// A routable place. category_results items are this shape plus distanceM;
// recent_searches_results items are this shape minus detail — so both lists
// feed the same "route to here" handler.
type Place = { name: string; detail?: string; lon: number; lat: number; distanceM?: number };

// Live proximity warning (V2X, Phase 21). Server scans every few seconds and
// pushes one of these when an active report is within PROXIMITY_RADIUS_M.
type ProximityAlert = { reportId: string; reportType: string; distanceM: number };

const PROXIMITY_VISIBLE_MS = 12000; // banner lifetime before it fades itself

// ---------- crowd report pins + validation (Phase 34) ----------
// Every active report (live broadcast or replay-on-connect) becomes a tappable
// map pin; tapping asks "עדיין שם?" and the crowd's votes keep the map honest —
// the server retires a report once its net score hits its threshold and tells
// every client to drop the pin at once (report_removed).
type ActiveReport = { id: string; reportType: string; lon: number; lat: number; ts: number };
// Mirrors the server's report TTL, so a pin the server would no longer replay
// isn't kept alive locally either.
const REPORT_PIN_TTL_MS = 60 * 60 * 1000;

// ---------- driver profile (Phase 22) ----------
// Presentation for the server's rank ladder. `minPoints` MIRRORS the RANKS
// table in server.js — the server is authoritative for which rank you hold
// (it sends the name); these thresholds are only used to draw the "points to
// next rank" bar, so a drift would mis-size the bar, never mis-state the rank.
// `label` is the Hebrew display name; the English key is what the server sends.
const RANK_TIERS: {
  key: string;
  label: string;
  icon: IoniconName;
  color: string;
  minPoints: number;
}[] = [
  { key: "New Driver", label: "נהג חדש", icon: "car-sport", color: "#64748B", minPoints: 0 },
  { key: "Road Knight", label: "אביר הדרך", icon: "shield-checkmark", color: "#3B82F6", minPoints: 51 },
  { key: "Navigation Master", label: "אלוף הניווט", icon: "trophy", color: "#F59E0B", minPoints: 201 },
];

// Unknown rank names (e.g. a future server tier) degrade gracefully: we show
// whatever the server called it, with neutral styling, instead of breaking.
function tierFor(rankKey: string) {
  return (
    RANK_TIERS.find((t) => t.key === rankKey) ?? {
      key: rankKey,
      label: rankKey,
      icon: "person" as IoniconName,
      color: "#0A6CFF",
      minPoints: 0,
    }
  );
}

// The next tier up, or null at the top of the ladder.
function nextTierFor(points: number) {
  return RANK_TIERS.find((t) => points < t.minPoints) ?? null;
}

// ---------- saved places (Phase 25) ----------
// A stored destination. "Home" and "Work" are singleton labels the server
// enforces; anything else is an ordinary favourite and may repeat, so deletion
// always goes by placeId.
type SavedPlace = {
  placeId: string;
  label: string;
  address: string;
  lat: number;
  lon: number;
};

const HOME_LABEL = "Home";
const WORK_LABEL = "Work";

type Profile = {
  points: number;
  totalDistanceKm: number;
  rank: string;
  savedPlaces: SavedPlace[];
  persisted: boolean;
};

// ---------- social live map (Phase 24) ----------
// One other driver, as sent by the server every ~3s. `heading` is degrees
// clockwise from north, or -1 when the GPS couldn't determine a course.
type NearbyDriver = {
  deviceId: string;
  lon: number;
  lat: number;
  heading: number;
  speed: number;
  rank: string;
  distanceM: number;
};

// Nearby drivers stop rendering once their frame is this stale. The server
// drops a driver after 20s of silence, but if OUR socket dies we'd otherwise
// keep painting a frozen crowd on the map forever.
const NEARBY_STALE_MS = 20000;

// ---------- social interactions (Phase 26) ----------
// Tap radius for hitting a driver marker, in POINTS (roughly finger-sized).
// Converted to metres at press time using the live zoom, so the target stays
// the same physical size on screen at every scale.
const DRIVER_TAP_RADIUS_PX = 30;
// Web-mercator ground resolution at zoom 0, equator (m/px). Divided by 2^zoom
// and scaled by cos(latitude) to get metres-per-pixel at the current view.
const MERCATOR_M_PER_PX_Z0 = 156543.03392;
// Nominal size of the interaction bubble, used to clamp it inside the viewport
// when anchoring it to the tapped car. Kept in sync with the driverCard style.
const DRIVER_CARD_W = 260;
const DRIVER_CARD_H = 260;

// ---------- turn lane guidance (Phase 33) ----------
// Show the lane HUD from this distance out. Far enough to actually change lane
// safely, close enough that it's about THIS junction and not the next one.
const LANE_ASSIST_M = 400;

// ---------- GPS acceptance (Phase 54) ----------
// Worse than this and a fix is treated as advisory only: it updates the quality
// banner but does not move the map, re-measure speed, or get sent to the server.
const GPS_MAX_ACCURACY_M = 50;
// ...but a filter that can starve the map is worse than a jumpy map. If nothing
// has been accepted for this long, the next fix is taken whatever its accuracy,
// so a tunnel, a car park or an indoor desk degrades to "imprecise" rather than
// to "frozen". This is the guard the field report's "freezing" half needs.
const GPS_STALE_MS = 12000;
// Implied speed above which a fix is a teleport rather than a movement — a
// network fix landing on a cell tower a kilometre away arrives looking exactly
// like this. 75 m/s is 270 km/h: unreachable in a car, comfortably above any
// legitimate motorway fix plus jitter.
const GPS_MAX_IMPLIED_MPS = 75;

// Lanes to assume when the OSM corridor lookup gives us nothing.
//
// PHASE 42 — this constant exists because the two halves of the lane stack used
// to disagree. resolveLaneAssist() has always fallen back to 2 ("it still
// communicates WHICH SIDE to be on"), while splitByLanes() was called with no
// fallback and therefore fell back to 1. On any road where Overpass returned no
// lane data — the common case, and the same condition behind the Phase 36
// zero-lights bug — the carriageway drew 3.6m of asphalt while the arrows and
// the corridor were laid out across 7.2m. Measured consequence: half the
// corridor (1.8m) floated off the road surface entirely, and the outermost
// arrows overhung the edge by 0.6m. Both halves now read the same number.
const LANE_COUNT_FALLBACK = 2;

/**
 * Rotation (degrees) for a lane's arrow.
 *
 * One upward arrow rotated per indication, rather than a sprite per direction:
 * the angles are the real geometry of the turn, so "slight right" genuinely
 * leans slightly right instead of being approximated by a right arrow. These
 * are React Native views, so unlike map symbols there's no glyph-range limit.
 */
const LANE_ARROW_ROTATION: Record<string, number> = {
  none: 0,
  straight: 0,
  "slight right": 40,
  right: 90,
  "sharp right": 135,
  uturn: 180,
  "sharp left": -135,
  left: -90,
  "slight left": -40,
};

/** Primary indication of a lane — the one drawn largest. */
function laneArrowAngle(lane: TurnLane): number {
  for (const ind of lane.indications) {
    const a = LANE_ARROW_ROTATION[ind];
    if (a !== undefined) return a;
  }
  return 0;
}

// ---------- traffic signals + countdown (Phase 28) ----------
type TrafficSignal = {
  id: string;
  lon: number;
  lat: number;
  /** Phase 34: true = heuristically inferred by the server, not OSM-surveyed. */
  inferred?: boolean;
  /** Phase 34: raw stop-line nodes the server clustered into this one icon. */
  count?: number;
};

// Show the countdown card once the next light is this close.
const SIGNAL_ALERT_M = 300;// Simulated light cycle. No municipality publishes live phase data, so the
// countdown is DERIVED, not measured: a fixed cycle offset per intersection.
// Printed on boot and sent with the first ping, so the running build is
// identifiable from the Metro console AND the server log. Two rounds of field
// reports were spent on bugs that turned out to be already-fixed-but-not-
// flashed; this makes that check take one second.
const BUILD_TAG = "phase-53";

// ---- simulated signal cycle -------------------------------------------------
// PHASE 52: retuned to ~30s green / ~45s red (75s cycle) on field feedback —
// the previous 32/28 read as implausibly quick for an urban junction, where a
// full cycle is typically 60-90s and red is the longer half. Still a
// SIMULATION, and still labelled "משוער" wherever it is shown: no municipal
// feed exists for Tiberias, so this communicates "roughly how long" rather
// than claiming a real countdown.
//
// NOTE: the cycle lives here, client-side. inferredTrafficLights.js on the
// server decides WHERE lights are, not when they change.
const SIGNAL_CYCLE_S = 75;
const SIGNAL_GREEN_S = 30; // remainder (45s) is red

/**
 * Deterministic per-intersection phase offset.
 *
 * Hashing the coordinates means each light keeps its OWN steady rhythm — the
 * same light always shows the same phase at the same moment, so the countdown
 * ticks smoothly instead of jumping as fixes arrive, and neighbouring lights
 * are naturally out of step the way a real corridor is. Nothing here claims to
 * match the real signal; it's an honest simulation, and the UI labels it.
 */
function signalOffset(sig: TrafficSignal): number {
  const key = `${sig.lon.toFixed(5)}${sig.lat.toFixed(5)}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(h) % SIGNAL_CYCLE_S;
}

/** Current simulated phase for a light: colour + seconds until it changes. */
function signalPhase(sig: TrafficSignal, nowMs: number) {
  const t = (Math.floor(nowMs / 1000) + signalOffset(sig)) % SIGNAL_CYCLE_S;
  return t < SIGNAL_GREEN_S
    ? { green: true, secondsLeft: SIGNAL_GREEN_S - t }
    : { green: false, secondsLeft: SIGNAL_CYCLE_S - t };
}

/** Initial bearing from A to B, in degrees clockwise from north. */
function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

/** Smallest absolute angle between two bearings, 0-180. */
function angleDelta(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

/**
 * Point that lies `distanceM` further along `coords`, starting from whichever
 * vertex is closest to (fromLat, fromLon).
 *
 * Used to place the maneuver marker: the server tells us how far the next turn
 * is but not where it is, and walking the geometry we already hold recovers the
 * coordinate without another round-trip.
 */
function pointAlongRoute(
  coords: [number, number][],
  fromLat: number,
  fromLon: number,
  distanceM: number
): [number, number] | null {
  if (!coords || coords.length < 2 || !Number.isFinite(distanceM)) return null;
  // nearest vertex = our position on the line (good enough at 5m vertex spacing)
  let startIdx = 0;
  let best = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = haversineM(fromLat, fromLon, coords[i][1], coords[i][0]);
    if (d < best) {
      best = d;
      startIdx = i;
    }
  }
  let remaining = distanceM;
  for (let i = startIdx; i < coords.length - 1; i++) {
    const [aLon, aLat] = coords[i];
    const [bLon, bLat] = coords[i + 1];
    const seg = haversineM(aLat, aLon, bLat, bLon);
    if (seg <= 0) continue;
    if (remaining <= seg) {
      const f = remaining / seg; // linear interpolation is fine over ~metres
      return [aLon + (bLon - aLon) * f, aLat + (bLat - aLat) * f];
    }
    remaining -= seg;
  }
  return coords[coords.length - 1]; // ran past the end: clamp to destination
}

/** The slice of route between the driver and the upcoming maneuver. */
function routeSliceAhead(
  coords: [number, number][],
  fromLat: number,
  fromLon: number,
  distanceM: number
): [number, number][] {
  if (!coords || coords.length < 2) return [];
  let startIdx = 0;
  let best = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = haversineM(fromLat, fromLon, coords[i][1], coords[i][0]);
    if (d < best) {
      best = d;
      startIdx = i;
    }
  }
  const out: [number, number][] = [coords[startIdx]];
  let remaining = distanceM;
  for (let i = startIdx; i < coords.length - 1 && remaining > 0; i++) {
    const [aLon, aLat] = coords[i];
    const [bLon, bLat] = coords[i + 1];
    const seg = haversineM(aLat, aLon, bLat, bLon);
    if (seg <= 0) continue;
    if (remaining <= seg) {
      const f = remaining / seg;
      out.push([aLon + (bLon - aLon) * f, aLat + (bLat - aLat) * f]);
      break;
    }
    out.push(coords[i + 1]);
    remaining -= seg;
  }
  return out.length >= 2 ? out : [];
}

// Single ASCII letter per rank, used as the on-marker badge. ASCII lives in
// glyph range 0-255, which both basemaps always serve — the same reason the
// route chevrons use "»". A Hebrew label here would need glyph range 1280-1535,
// which is NOT reliably served and would render as blank boxes.
const RANK_INITIAL: Record<string, string> = {
  "New Driver": "N",
  "Road Knight": "K",
  "Navigation Master": "M",
};

// In-drive toast clearance. The toast is BOTTOM-anchored on purpose: every
// other overlay that could clash with it (hazard banner, maneuver card, GPS /
// off-route strip) is TOP-anchored, so the two groups can never meet. These
// offsets lift it clear of the bottom furniture in each phase:
//   driving — speed pill tops out at insets.bottom+120, recenter at +184
//   preview — the ETA card is ~215pt tall above insets.bottom
// Phase 46: bottom HUD stack. The dashboard is the anchor; everything that used
// to sit at the screen bottom while driving now stacks ABOVE it. Expressed once
// here so the offsets can't drift apart the way the top stack's did.
// ---------- voice guidance thresholds (Phase 47) ----------
// Three stages, largest first. Replaces a two-stage 500m/50m scheme.
//
// 800m matches where the camera starts leaning in (CAM_FAR_M), so the audio and
// the view begin preparing for the same junction together. It also buys real
// time: at 90km/h on Route 90, 500m was 20 seconds of notice to cross lanes,
// which is not enough. 250m is the commit point in town, and 50m is the act.
const VOICE_TIERS_M = [800, 250, 50] as const;
// Minimum ground covered between two cues for the SAME maneuver. Without it, a
// turn first seen at 300m announces at 300 and again at 240 — two cues about
// four seconds apart, which is chatter rather than guidance. Rate-limiting by
// distance rather than by a timer keeps it consistent with everything else here.
// NEVER applied to the final tier: the "act now" cue is the one instruction that
// must not be swallowed, whatever came before it.
const VOICE_MIN_GAP_M = 100;
// Compact metrics pill (Phase 48), bottom-RIGHT. Was a 96px full-width bar.
const TRIP_PILL_H = 62;
const TRIP_DASH_GAP = 12;
// Height of the speedometer group that sits directly above the dashboard:
// 76 pill + 8 gap + 58 limit sign. Anything that has to clear it (the toast)
// steps by this rather than by a hand-tuned number.
const SPEEDO_STACK_H = 142;
const TOAST_BOTTOM_PREVIEW = 245;

function maneuverDist(m: Maneuver): string {
  return m.distanceM >= 1000
    ? `${(m.distanceM / 1000).toFixed(1)} ק״מ`
    : `${Math.max(0, Math.round(m.distanceM / 10) * 10)} מ׳`;
}

// Hebrew turn modifiers (RTL). Grammar: verb then direction, e.g. "פנה ימינה".
const MODIFIER_HE: Record<string, string> = {
  left: "שמאלה",
  right: "ימינה",
  "slight left": "קלות שמאלה",
  "slight right": "קלות ימינה",
  "sharp left": "בחדות שמאלה",
  "sharp right": "בחדות ימינה",
  straight: "ישר",
  uturn: "פניית פרסה",
};

function maneuverLabel(m: Maneuver): string {
  const t = m.type ?? "";
  const onto = m.name ? ` לרחוב ${m.name}` : "";
  if (t === "arrive") return "הגעת ליעד";
  if (t.includes("roundabout") || t === "rotary")
    return `בכיכר${m.exit ? ` צא ביציאה ${m.exit}` : ""}${onto}`;
  const mod = MODIFIER_HE[m.modifier ?? ""] ?? "";
  if (t === "merge") return `היכנס${mod ? ` ${mod}` : ""}${onto}`;
  if (t === "on ramp") return `עלה למחלף${onto}`;
  if (t === "off ramp") return `צא ביציאה${onto}`;
  if (t === "fork") return `היצמד${mod ? ` ${mod}` : ""}${onto}`;
  if (t === "depart" || t === "continue" || t === "new name")
    return `המשך${mod ? ` ${mod}` : ""}${onto}`;
  // default: a turn
  return `פנה${mod ? ` ${mod}` : ""}${onto}`;
}

// Hebrew distance phrase for speech, e.g. "בעוד 300 מטר" / "בעוד 1.5 קילומטר".
function distancePhraseHe(d: number): string {
  return d >= 1000 ? `בעוד ${(d / 1000).toFixed(1)} קילומטר` : `בעוד ${Math.round(d / 10) * 10} מטר`;
}

// Spoken form in Hebrew: distance-prefixed instruction. Arrival and immediate
// turns drop the distance. e.g. "בעוד 300 מטר, פנה שמאלה לרחוב שדרות הרצל."
function maneuverSpeech(m: Maneuver): string {
  const label = maneuverLabel(m);
  if ((m.type ?? "") === "arrive") return label + ".";
  const d = m.distanceM;
  if (d < 40) return `כעת, ${label}.`; // "now, ..."
  return `${distancePhraseHe(d)}, ${label}.`;
}

// stable identity of a maneuver, so voice fires once per turn (not per ping)
/**
 * Identity of a maneuver, stable across pings and distinct between maneuvers.
 *
 * PHASE 47 BUG FIX. This was `type|modifier|name`, which is a DESCRIPTION, not
 * an identity: two consecutive unnamed same-direction turns collide, and OSRM
 * reports an empty name for unnamed ways, so that happens constantly in the old
 * town. The voice cue flags are reset on key change, so a collision meant the
 * second turn's flags stayed "already spoken" and it was never announced.
 *
 * alongM is the maneuver's fixed position along the route, so it can't collide.
 * The descriptive fields are retained as a fallback for older servers that don't
 * send it — degraded, but no worse than before.
 */
function maneuverKey(m: Maneuver | null): string {
  if (!m) return "";
  return Number.isFinite(m.alongM)
    ? `@${m.alongM}`
    : `${m.type}|${m.modifier}|${m.name}`;
}

// ---------- trip summary formatting (preview card) ----------
function fmtDuration(durationS: number): string {
  const min = Math.max(1, Math.round(durationS / 60));
  if (min < 60) return `${min} דק׳`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} שע׳ ${m} דק׳` : `${h} שע׳`;
}

function fmtDistance(distanceM: number): string {
  return distanceM >= 1000 ? `${(distanceM / 1000).toFixed(1)} ק״מ` : `${Math.round(distanceM / 10) * 10} מ׳`;
}

function fmtEta(durationS: number): string {
  const arrival = new Date(Date.now() + durationS * 1000);
  return arrival.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Great-circle distance in metres. Used by the driver tap hit-test.
function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// bounding box [w,s,e,n] of a route LineString, for the overview camera
function routeBounds(coords: [number, number][]): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [lon, lat] of coords) {
    if (lon < w) w = lon;
    if (lon > e) e = lon;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  }
  return [w, s, e, n];
}

// Guard against the most common failure: an older package generation installed
// (v9 default-namespace or v10 MapView-named API) whose v11 exports resolve to
// undefined — rendering would crash with "Element type is invalid". Render a
// self-diagnosing screen instead. TypeScript's types say these are always
// defined, so we read through the namespace object (a runtime check the type
// system can't see) rather than testing the imported bindings directly.
const MAPLIBRE_READY = ["Map", "Camera", "GeoJSONSource", "Layer", "NativeUserLocation"].every(
  (name) => (MapLibreNS as Record<string, unknown>)[name] != null
);

export default function MapScreen() {
  if (!MAPLIBRE_READY) return <MapLibreSetupError />;
  return <MapScreenBoot />;
}

/**
 * Boot gate. Resolves the persisted device id BEFORE mounting the map screen.
 *
 * This ordering is the whole point: MapScreenInner opens the telemetry socket
 * and fires get_profile / get_recent_searches in its very first effects. If it
 * mounted with a placeholder id it would register a phantom driver in the live
 * map, request a profile that doesn't exist, and then need a reconnect once the
 * real id arrived. Gating instead of patching afterwards means every message
 * that ever leaves this app carries the correct identity.
 *
 * The read is a single AsyncStorage hit — typically a few milliseconds, so in
 * practice this splash is a flash rather than a visible screen.
 */
function MapScreenBoot() {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [storageWarning, setStorageWarning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadOrCreateDeviceId().then(({ deviceId: id, persisted, created }) => {
      if (cancelled) return;
      if (created) {
        console.log(`[deviceId] ${persisted ? "created and stored" : "session-only"}: ${id}`);
      }
      setStorageWarning(!persisted);
      setDeviceId(id); // last: mounting the map is what this gate is guarding
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!deviceId) return <BootSplash />;
  return <MapScreenInner deviceId={deviceId} storageWarning={storageWarning} />;
}

/**
 * Shown only while the id is being read. Uses the same time-of-day rule as the
 * main screen so boot doesn't flash white at night, and its own tiny stylesheet
 * because makeStyles() lives inside the component tree we haven't entered yet.
 */
function BootSplash() {
  const hour = new Date().getHours();
  const dark = hour >= 18 || hour < 6;
  return (
    <View style={[bootStyles.container, { backgroundColor: dark ? DARK.sheetBg : LIGHT.sheetBg }]}>
      <Ionicons name="navigate-circle" size={54} color={C.wazeBlue} />
      <ActivityIndicator color={C.wazeBlue} />
    </View>
  );
}

const bootStyles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center", gap: 18 },
});

function MapLibreSetupError() {
  const ns = MapLibreNS as Record<string, any>;
  const liveKeys = Object.keys(ns ?? {}).filter((k) => ns[k] !== undefined);
  const v9Detected = !!(ns?.default && (ns.default.MapView || ns.default.Camera));
  const v10Detected = !!(ns?.MapView && !ns?.Map);
  const diagnosis = v9Detected
    ? "Diagnosis: v9.x is installed (default-namespace API)."
    : v10Detected
      ? "Diagnosis: v10.x is installed (MapView/ShapeSource API) — this app targets v11."
      : liveKeys.length === 0
        ? "Diagnosis: the module resolved empty — broken install or stale Metro cache. Run npm install and npx expo start -c first."
        : "Diagnosis: unexpected export shape — screenshot this screen and report it.";
  return (
    <View style={setupStyles.container}>
      <Text style={setupStyles.title}>MapLibre isn't linked correctly</Text>
      <Text style={setupStyles.text}>
        The v11 named exports of @maplibre/maplibre-react-native (Map,
        GeoJSONSource, Layer, ...) resolved to undefined. Live exports of the
        installed module:
      </Text>
      <Text style={setupStyles.code}>
        {liveKeys.length ? liveKeys.slice(0, 14).join(", ") : "(none)"}
      </Text>
      <Text style={setupStyles.text}>{diagnosis}</Text>
      <Text style={setupStyles.code}>
        npx expo install @maplibre/maplibre-react-native@^11
      </Text>
      <Text style={setupStyles.text}>
        After any version switch a NATIVE rebuild is mandatory: npx expo
        prebuild --clean, then npx expo run:android — a JS reload (r) is not
        enough. Full runbook: README → Troubleshooting.
      </Text>
    </View>
  );
}

// Isolated, memoized speedometer. Repaints only when the rounded km/h value
// changes — not on every location field update — so the frequent GPS stream
// never re-renders the map or bottom sheet. Over-speed styling is derived
// internally from the same value. Uses its own STATIC stylesheet (speedStyles)
// so the Phase 16 theme flip can't re-render it either — the pill keeps its
// dark HUD look over the map in both themes.
type SpeedometerProps = {
  speedKmh: number | null;
  /** Legal limit for the current stretch, or null when OSM doesn't know. */
  limitKmh: number | null;
  bottom: number;
};

/**
 * The regulatory speed-limit sign: white disc, red annulus, black numeral —
 * the Vienna Convention form used on Israeli and European roads.
 *
 * Rendered ONLY when limitKmh is a real value. It is a claim about the law, so
 * an approximation would be worse than an absence; there is no "probably 50"
 * state. Kept smaller than the speed pill below it because the number the
 * driver has to act on is their own speed — the limit is the reference.
 */
const SpeedLimitSign = React.memo(function SpeedLimitSign({ kmh }: { kmh: number }) {
  return (
    <View style={speedStyles.sign} accessibilityLabel={`מהירות מותרת ${kmh}`}>
      <Text style={speedStyles.signText} allowFontScaling={false}>
        {kmh}
      </Text>
    </View>
  );
});

/**
 * Speed HUD: current speed, plus the limit sign when we know it.
 *
 * Still memoized on the rounded km/h value, so the GPS stream doesn't repaint
 * the map — and the over-speed pulse is driven by Animated with
 * useNativeDriver, so the loop runs on the native thread and costs ZERO React
 * renders per frame. That matters: a JS-driven pulse here would re-render this
 * subtree ~60 times a second and undo the isolation the memo exists for.
 *
 * The pulse is intentionally slow (1.1s cycle) and peripheral rather than a
 * flash. A hard strobe in the driver's field of view is a hazard, not a warning.
 */
const Speedometer = React.memo(function Speedometer({
  speedKmh,
  limitKmh,
  bottom,
}: SpeedometerProps) {
  const threshold = limitKmh ?? SPEED_LIMIT_FALLBACK_KMH;
  const over =
    speedKmh != null && threshold != null && speedKmh > threshold + SPEED_TOLERANCE_KMH;

  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!over) {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 550,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 550,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => {
      loop.stop();
      pulse.setValue(0);
    };
  }, [over, pulse]);

  return (
    <View style={[speedStyles.hud, { bottom }]} pointerEvents="none">
      {limitKmh != null && <SpeedLimitSign kmh={limitKmh} />}
      <View style={speedStyles.pillWrap}>
        {/* Halo sits BEHIND the opaque pill, so only the part that scales past
            the rim is visible — a soft expanding ring rather than a flash. */}
        <Animated.View
          style={[
            speedStyles.halo,
            {
              opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0, 0.5] }),
              transform: [
                { scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.3] }) },
              ],
            },
          ]}
        />
        <View style={[speedStyles.pill, over && speedStyles.pillAlert]}>
          <Text style={[speedStyles.value, over && speedStyles.valueAlert]} allowFontScaling={false}>
            {speedKmh != null ? speedKmh : "–"}
          </Text>
          <Text style={[speedStyles.unit, over && speedStyles.unitAlert]}>קמ״ש</Text>
        </View>
      </View>
    </View>
  );
});

/**
 * Bottom trip dashboard (Phase 46): time left, distance left, ETA, and the exit.
 *
 * WHY THIS EXISTS AT ALL: until now the driving screen had no trip metrics and,
 * more importantly, NO WAY TO STOP. cancelPreview() was wired only to the
 * preview card, so once a route was live the driver could reach idle by force-
 * quitting the app and nothing else. The exit button below is the actual fix;
 * the metrics are the reason there's a surface to put it on.
 *
 * Memoized, and it re-renders only when one of the four displayed values
 * changes. Minutes and the ETA clock move on the order of once a minute, so in
 * practice this repaints far less often than the GPS stream ticks.
 *
 * A null remainingS renders as an em-dash rather than a guess: the server sends
 * null when it has no duration profile, and a fabricated ETA is worse than a
 * visibly absent one when someone is deciding whether they'll make an
 * appointment.
 */
type TripDashboardProps = {
  remainingM: number | null;
  remainingS: number | null;
  bottom: number;
};
const TripDashboard = React.memo(function TripDashboard({
  remainingM,
  remainingS,
  bottom,
}: TripDashboardProps) {
  return (
    <View style={[tripStyles.pill, { bottom }]} pointerEvents="none">
      {/* Time left is the primary read and gets the large type. Distance and ETA
          share the line below: both are reference figures you check rather than
          act on, so they don't need to compete for size. */}
      <Text style={tripStyles.primary} numberOfLines={1} allowFontScaling={false}>
        {remainingS != null ? fmtDuration(remainingS) : "\u2014"}
      </Text>
      <Text style={tripStyles.secondary} numberOfLines={1} allowFontScaling={false}>
        {remainingM != null ? fmtDistance(remainingM) : "\u2014"}
        {"  \u00b7  "}
        {remainingS != null ? fmtEta(remainingS) : "\u2014"}
      </Text>
    </View>
  );
});

/**
 * Isolated, memoized search row (Phase 30).
 *
 * Declared at MODULE level — never inside the render — because a component
 * defined during render is a NEW component type on every pass, which makes
 * React unmount and remount the subtree, and a remounted TextInput loses focus
 * and drops the keyboard. That failure mode is not what caused the field bug
 * (see the keyboard notes in MapScreenInner), but this is the shape of code
 * that would cause it, so it is worth being explicit about.
 *
 * What the memo actually buys us: MapScreenInner re-renders on every telemetry
 * ping, every GPS fix and the 2s heartbeat — several times a second while
 * driving. Every one of those used to walk the whole search row again. Now the
 * row only re-renders when the text, the callbacks or the theme genuinely
 * change, so background updates can't add latency to typing.
 *
 * All props are referentially stable except `value`: onChangeText is a
 * useCallback([]), `styles` is memoized on the theme, and subColor is a string.
 */
type Styles = ReturnType<typeof makeStyles>;

type SearchBarProps = {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit: () => void;
  onClear: () => void;
  styles: Styles;
  subColor: string;
};

const SearchBar = React.memo(function SearchBar({
  value,
  onChangeText,
  onSubmit,
  onClear,
  styles,
  subColor,
}: SearchBarProps) {
  return (
    <View style={styles.searchRow}>
      <Ionicons name="mic-outline" size={20} color={subColor} />
      <TextInput
        style={styles.searchInput}
        value={value}
        onChangeText={onChangeText}
        placeholder="לאן?"
        placeholderTextColor={subColor}
        returnKeyType="search"
        autoCapitalize="none"
        autoCorrect={false}
        onSubmitEditing={onSubmit}
        textAlign="right"
        // Deliberately NOT autoFocus: the field is focused by the user's tap.
        // Auto-focusing here would re-grab focus on any remount and is exactly
        // the kind of thing that turns a single glitch into a loop.
      />
      {value.length > 0 ? (
        <Pressable style={styles.searchClear} onPress={onClear} hitSlop={8}>
          <Ionicons name="close-circle" size={18} color={subColor} />
        </Pressable>
      ) : (
        <Ionicons name="search" size={18} color={subColor} />
      )}
    </View>
  );
});

type MapScreenInnerProps = { deviceId: string; storageWarning: boolean };

function MapScreenInner({ deviceId: DEVICE_ID, storageWarning }: MapScreenInnerProps) {
  const insets = useSafeAreaInsets();
  const { width: winW, height: winH } = useWindowDimensions();
  // Phase 16: auto dark mode. Night = 18:00–05:59 local time. Computed per
  // render — the ~2 s telemetry re-render means the flip lands within seconds
  // of the boundary without a dedicated timer. `theme` feeds makeStyles and
  // the inline icon colors; the two style URLs swap the basemap itself. The
  // Speedometer and the dark driving HUD deliberately do NOT re-theme (they
  // sit over the map and keep their own glass look in both modes).
  const hour = new Date().getHours();
  const isDarkMode = hour >= 18 || hour < 6;
  const theme = isDarkMode ? DARK : LIGHT;
  const styles = useMemo(() => makeStyles(theme), [isDarkMode]); // eslint-disable-line react-hooks/exhaustive-deps
  const [route, setRoute] = useState<RouteFeature | null>(null);
  const [status, setStatus] = useState<RouteStatus>({
    onRoute: null,
    distanceM: null,
    progressPct: null,
    remainingM: null,
    remainingS: null,
    route: null,
    maneuver: null,
  });
  const [connected, setConnected] = useState(false);
  const [fix, setFix] = useState<Location.LocationObject | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  // Dedicated speed state for the memoized Speedometer. Updated only when the
  // rounded km/h actually changes, so it doesn't repaint on every fix.
  const [speedKmh, setSpeedKmh] = useState<number | null>(null);
  const speedKmhRef = useRef<number | null>(null);
  // Phase 44: legal limit for the stretch under the car. Held as state for the
  // HUD, mirrored in a ref, and — like the speed above — only pushed to state
  // when the VALUE changes, so a stationary car on a mapped road doesn't
  // re-render anything. laneSamples lives in a ref as well because updateSpeed
  // is a [] -dep callback that the location watcher depends on; closing over the
  // samples directly would give it a new identity on every corridor update and
  // restart the GPS subscription.
  const [speedLimitKmh, setSpeedLimitKmh] = useState<number | null>(null);
  const speedLimitRef = useRef<number | null>(null);
  const laneSamplesRef = useRef<LaneSample[]>([]);
  // Accuracy of the most recent RAW fix, accepted or not — what the quality
  // banner should reflect. Kept in a ref so a stream of rejected fixes doesn't
  // re-render anything.
  const rawAccuracyRef = useRef<number | null>(null);
  const lastAcceptedRef = useRef<Location.LocationObject | null>(null);

  /**
   * Should this fix be allowed to move the map and reach the server?
   *
   * PHASE 54. Three ways to say no, and one overriding way to say yes.
   *
   * The overriding yes comes first on purpose: if nothing has been accepted for
   * GPS_STALE_MS, the fix is taken regardless. A filter with no such escape is
   * how you turn "the map jumps" into "the map is frozen", which is the worse
   * failure and the one that looks like a crash.
   */
  const acceptFix = useCallback((loc: Location.LocationObject) => {
    const prev = lastAcceptedRef.current;
    const now = loc.timestamp || Date.now();

    // No fix yet, or nothing for a long time -> take it. Imprecise beats frozen.
    if (!prev || now - (prev.timestamp || 0) > GPS_STALE_MS) {
      lastAcceptedRef.current = loc;
      return true;
    }

    const acc = loc.coords.accuracy;
    if (Number.isFinite(acc) && (acc as number) > GPS_MAX_ACCURACY_M) return false;

    // Teleport check. A fix can carry a good accuracy figure and still be in the
    // wrong place; implied speed catches what the accuracy number doesn't.
    const dt = Math.max(0.25, (now - (prev.timestamp || now)) / 1000);
    const d = haversineM(
      prev.coords.latitude,
      prev.coords.longitude,
      loc.coords.latitude,
      loc.coords.longitude
    );
    if (d / dt > GPS_MAX_IMPLIED_MPS) return false;

    lastAcceptedRef.current = loc;
    return true;
  }, []);

  const updateSpeed = useCallback((loc: Location.LocationObject) => {
    const s = loc.coords.speed;
    const kmh = s != null && s >= 0 ? Math.round(s * 3.6) : null;
    if (kmh !== speedKmhRef.current) {
      speedKmhRef.current = kmh;
      setSpeedKmh(kmh);
    }
    const samples = laneSamplesRef.current;
    const limit = samples.length
      ? speedLimitAt(samples, loc.coords.longitude, loc.coords.latitude)
      : null;
    if (limit !== speedLimitRef.current) {
      speedLimitRef.current = limit;
      setSpeedLimitKmh(limit);
    }
  }, []);
  const [nowTick, setNowTick] = useState(Date.now()); // re-evaluates GPS staleness

  // heartbeat so a fix that stops arriving is detected as stale
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 2000);
    return () => clearInterval(id);
  }, []);

  // ---------- Keyboard handling (Phase 30 field fix) ----------
  //
  // THE BUG THIS FIXES: tapping the search bar opened the keyboard for a split
  // second, then the sheet "collapsed", in a loop.
  //
  // It was never a re-render problem — it was a DOUBLED OFFSET. Android's
  // default windowSoftInputMode is adjustResize (Expo's default, and nothing
  // here overrides it), so when the keyboard opens the OS already shrinks the
  // app window to sit ABOVE the keyboard. A sheet pinned to bottom:0 is
  // therefore already in the right place. We then lifted it AGAIN by the full
  // keyboard height, launching it ~350 px further up — dragging the search row
  // off the top of the shrunken viewport. Losing the focused input closed the
  // keyboard, which reset keyboardH to 0, which dropped the sheet back, and the
  // whole thing oscillated for as long as the user kept tapping.
  //
  // iOS does NOT resize: the keyboard is an overlay, so there the JS lift is
  // genuinely required. Hence: lift on iOS, never on Android. This is the "keep
  // exactly one mechanism" rule the original comment warned about.
  //
  // keyboardH is still tracked on BOTH platforms — the padding below uses it to
  // drop the home-indicator inset once the keyboard covers that area.
  // One line in the Metro console identifying the running build.
  useEffect(() => {
    console.log(`[tiberias-nav] build ${BUILD_TAG}`);
  }, []);

  const [keyboardH, setKeyboardH] = useState(0);
  //
  // PHASE 49 UPDATE — the platform moved under this fix.
  //
  // The Phase 30 reasoning above was correct FOR ITS TIME: Android's
  // adjustResize did shrink the window, so lifting in JS as well double-
  // offset the sheet. That contract is now void. This app targets Expo SDK
  // 57 / RN 0.86, and from Android 15 (targetSdk 35) EDGE-TO-EDGE IS FORCED:
  // the window no longer resizes for the keyboard at all. The system just
  // hands the app an IME inset and expects it to react. Nothing lifts the
  // sheet unless we do — which is why the keyboard started covering the
  // search field again with no JS change to blame.
  //
  // So the lift now runs on BOTH platforms: iOS because its keyboard was
  // always an overlay, Android because its window no longer resizes. The
  // Phase 30 doubled-offset cannot return unless edge-to-edge is switched
  // off, which Android 15+ does not permit.
  //
  // Why not KeyboardAvoidingView (the usual advice): it cannot lift an
  // ABSOLUTELY POSITIONED child, and this sheet is position:absolute over
  // the map by design — that is precisely why the manual keyboardH path
  // exists (see the Phase 10 note). Wrapping the sheet in one would change
  // nothing on either platform.
  const KEYBOARD_LIFTS_SHEET = true;
  useEffect(() => {
    const showEvt = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvt = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const onShow = Keyboard.addListener(showEvt, (e) => setKeyboardH(e.endCoordinates?.height ?? 0));
    const onHide = Keyboard.addListener(hideEvt, () => setKeyboardH(0));
    return () => {
      onShow.remove();
      onHide.remove();
    };
  }, []);

  // server host: initialized from override/Metro/localhost, editable at runtime
  const [serverHost, setServerHost] = useState<string>(SERVER_HOST);
  const [editingHost, setEditingHost] = useState(false);
  // Phase 13/15: traffic report menu. submitReport is defined further down,
  // after sendJson exists (its deps reference sendJson — declaration order matters).
  const [reportOpen, setReportOpen] = useState(false);
  const [hostDraft, setHostDraft] = useState("");
  // Scheme is derived from the host: wss:// for a deployed backend (cloud
  // platforms only expose TLS on 443), ws:// for a LAN dev box on its port.
  const wsUrl = `${wsBase(serverHost)}/track`;

  // Phase 17: category POI search (food / gas / emergency via Overpass).
  // activeCategoryRef mirrors the state so the socket closure can drop results
  // for a category the user has already switched away from — same guard the
  // search suggestions use against queryRef.
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const activeCategoryRef = useRef<string | null>(null);
  const [categoryItems, setCategoryItems] = useState<Place[]>([]);
  const [categoryBusy, setCategoryBusy] = useState(false);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  // Which backend answered: "overpass" (precise) | "nominatim" (coarse
  // fallback when Overpass is rate-limited) | "none".
  const [categorySource, setCategorySource] = useState<string | null>(null);

  // Phase 20: real recent searches, served from this device's history.
  // Starts empty — no placeholder rows — and fills in when the server answers.
  const [recent, setRecent] = useState<Place[]>([]);

  // Phase 21: V2X proximity warning currently on screen (null = none).
  const [proximity, setProximity] = useState<ProximityAlert | null>(null);

  // Phase 34: active crowd reports (rendered as map pins) and the one whose
  // "עדיין שם?" vote popup is currently open (null = closed).
  const [activeReports, setActiveReports] = useState<ActiveReport[]>([]);
  const [voteTarget, setVoteTarget] = useState<ActiveReport | null>(null);

  // Phase 22: driver profile sheet. `profile` is cached between openings so
  // re-opening shows the last known stats immediately while a fresh
  // get_profile is in flight, rather than flashing an empty state.
  const [profileOpen, setProfileOpen] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);

  // Phase 25: saved places. Kept as its own state (not read off `profile`) so
  // the Home/Work chips stay live after a save without needing a profile
  // refetch — save_place and delete_place both return the full updated list.
  const [savedPlaces, setSavedPlaces] = useState<SavedPlace[]>([]);
  // When set, the next search result is SAVED under this label instead of
  // routed to. Drives the "pick your home address" flow from an empty chip.
  const [pendingSaveLabel, setPendingSaveLabel] = useState<string | null>(null);
  const pendingSaveLabelRef = useRef<string | null>(null);
  const [placesOpen, setPlacesOpen] = useState(false);

  // Phase 24: other drivers within 5 km, refreshed by the server every ~3s.
  // `nearbyAt` timestamps the last frame so a dead socket doesn't leave a
  // frozen crowd painted on the map.
  const [nearbyDrivers, setNearbyDrivers] = useState<NearbyDriver[]>([]);
  const [nearbyAt, setNearbyAt] = useState(0);
  // Phase 26: the driver whose bubble is open (null = closed).
  const [tappedDriver, setTappedDriver] = useState<NearbyDriver | null>(null);
  // Screen coords of the tap, so the bubble opens beside the car. null = the
  // press carried no usable point, so the bubble centres instead.
  const [tapPoint, setTapPoint] = useState<{ x: number; y: number } | null>(null);
  // Phase 28: traffic lights along the active route, pushed by the server just
  // after new_route. Cleared whenever the route is dropped.
  // Phase 30: the intercepted basemap style — Hebrew labels, 3D buildings and
  // (at night) a deeper palette. null until it loads, and null forever if the
  // fetch fails, in which case we hand MapLibre the plain URL instead.
  const [styleJson, setStyleJson] = useState<StyleJson | null>(null);

  // Fetch + rewrite the basemap style whenever the theme flips. Results are
  // cached inside loadStyle(), so flipping back is instant and costs no
  // network. Setting null first means a theme change falls back to the plain
  // URL for the moment it takes to transform, rather than showing the previous
  // theme's palette.
  useEffect(() => {
    let cancelled = false;
    const url = isDarkMode ? MAP_STYLE_DARK : MAP_STYLE_LIGHT;
    setStyleJson(null);
    loadStyle(url, isDarkMode).then((s) => {
      if (!cancelled) setStyleJson(s);
    });
    return () => {
      cancelled = true;
    };
  }, [isDarkMode]);

  const [signals, setSignals] = useState<TrafficSignal[]>([]);
  // Phase 32: real per-direction lane counts sampled along the route, resolved
  // server-side from OSM `lanes` tags (with a highway-class fallback).
  const [laneSamples, setLaneSamples] = useState<LaneSample[]>([]);
  // Mirror the samples into a ref so updateSpeed (a [] -dep callback, and a
  // dependency of the location watcher) can read them without gaining a new
  // identity and restarting the GPS subscription.
  useEffect(() => {
    laneSamplesRef.current = laneSamples;
    if (laneSamples.length === 0 && speedLimitRef.current !== null) {
      // Route cleared or corridor unavailable: drop the sign rather than leave
      // yesterday's limit on screen. A stale regulatory value is worse than none.
      speedLimitRef.current = null;
      setSpeedLimitKmh(null);
    }
  }, [laneSamples]);
  // Fast ticker that drives the countdown digits and the arrow pulse. Only runs
  // while driving, so it costs nothing in idle.
  const [pulse, setPulse] = useState(0);

  // Phase 3/4/5: dynamic routing + structured search
  const [destination, setDestination] = useState<[number, number] | null>(null);
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [notice, setNotice] = useState<string | null>(
    "search above, or long-press the map to set a destination"
  );
  const fixRef = useRef<Location.LocationObject | null>(null);
  const queryRef = useRef("");        // current text, readable inside the socket closure
  const suppressSuggestRef = useRef(false); // skip the debounce fire caused by a tap

  // Phase 9: pre-drive flow. phase gates the whole experience; pendingRoute
  // holds the route awaiting a GO tap during preview.
  const [phase, setPhase] = useState<NavPhase>("idle");
  const phaseRef = useRef<NavPhase>("idle");
  const [pendingRoute, setPendingRoute] = useState<RouteFeature | null>(null);
  const setNavPhase = useCallback((p: NavPhase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  // Phase 29: chosen vehicle. The ref is what the send paths read, so adding
  // the profile to a request doesn't have to re-create every routing callback
  // (which would churn their dependency arrays). The state drives the UI.
  const [vehicle, setVehicle] = useState<VehicleProfile>("car");
  const vehicleRef = useRef<VehicleProfile>("car");
  // The last destination we routed to, so switching vehicle in the preview can
  // recompute the SAME trip with the new engine instead of losing it.
  const lastDestRef = useRef<{ lon: number; lat: number; name?: string } | null>(null);

  // Phase 6: navigation camera
  const cameraRef = useRef<CameraRef>(null);
  // Map ref, used only for queryRenderedFeaturesAtPoint on driver taps. Typed
  // loosely on purpose: the method's presence is probed at call time rather
  // than assumed from the type, since it varies across MapLibre generations.
  const mapRef = useRef<any>(null);
  const [cameraMode, setCameraMode] = useState<CameraMode>("follow");
  const cameraModeRef = useRef<CameraMode>("follow");
  const lastBearingRef = useRef(0); // last trustworthy course, kept while stationary
  // Phase 43 dynamic camera. driveCamera() is a useCallback with [] deps —
  // deliberately, because the location-watcher effect lists it as a dependency
  // and a new identity would tear down and restart the GPS subscription. So the
  // camera reads the live maneuver distance through a ref rather than closing
  // over state.
  const maneuverDistRef = useRef<number | null>(null);
  // Smoothed 0..1 approach ramp. Kept in a ref so it survives re-renders and
  // carries between fixes; exponential rather than raw so a reroute or a noisy
  // distanceM can't snap the pitch.
  const camRampRef = useRef(0);
  // Live zoom, needed to convert a finger-sized tap radius into metres. Read
  // defensively from the region event (field naming varies across MapLibre RN
  // generations) and seeded with the follow-mode default, so the hit-test is
  // always sane even if none of the shapes match.
  const zoomRef = useRef(15.5);
  const setMode = useCallback((mode: CameraMode) => {
    cameraModeRef.current = mode;
    setCameraMode(mode);
  }, []);

  // Phase 7: voice guidance. Two announcements per turn — an early heads-up and
  // a close-range cue — tracked so nothing repeats every ping.
  const [voiceOn, setVoiceOn] = useState(true);
  const voiceOnRef = useRef(true);
  // Phase 47: which cues have already been spoken for the maneuver identified by
  // `key`. One record instead of three parallel string refs — it scales with
  // VOICE_TIERS_M and makes "reset on new maneuver" a single assignment rather
  // than three that could fall out of step.
  const spokenRef = useRef<{ key: string; done: boolean[]; lastM: number | null }>({
    key: "",
    done: VOICE_TIERS_M.map(() => false),
    lastM: null,
  });
  const speak = useCallback((text: string) => {
    if (!voiceOnRef.current) return;
    Speech.stop();
    Speech.speak(text, { language: "he-IL", rate: 0.95, pitch: 1.0 });
  }, []);

  const wsRef = useRef<WebSocket | null>(null);
  const queueRef = useRef<string[]>([]);
  const retryMsRef = useRef(1000);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const routeRef = useRef<RouteFeature | null>(null);

  // Telemetry socket: reconnect with backoff + offline queue.
  // The hardcoded "hwy90-tiberias" demo route is GONE — nothing is fetched at
  // mount, so the app boots to a clean map centred on the user's GPS. A route
  // line only exists once the server answers a search with `new_route`.
  const connect = useCallback(() => {
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    // Ask for this device's recent destinations AND its saved places. Sent
    // directly on the live socket (not via sendJson) because they're only ever
    // fired from inside this closure, and a queued copy would be pointless —
    // we re-ask on reconnect anyway. get_profile carries savedPlaces, so the
    // Home/Work chips are populated before the driver can even tap them.
    const askRecents = () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "hello", deviceId: DEVICE_ID, build: BUILD_TAG }));
        ws.send(JSON.stringify({ type: "get_recent_searches", deviceId: DEVICE_ID }));
        ws.send(JSON.stringify({ type: "get_profile", deviceId: DEVICE_ID }));
      }
    };

    ws.onopen = () => {
      setConnected(true);
      retryMsRef.current = 1000;
      queueRef.current.splice(0).forEach((msg) => ws.send(msg)); // flush queue
      askRecents(); // populate the idle sheet's history list
    };
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(String(e.data));
        if (m.type === "status") {
          setStatus({
            onRoute: m.onRoute,
            distanceM: m.distanceM,
            progressPct: m.progressPct,
            remainingM: typeof m.remainingM === "number" ? m.remainingM : null,
            remainingS: typeof m.remainingS === "number" ? m.remainingS : null,
            route: m.route ?? null,
            maneuver: m.maneuver ?? null,
          });
        } else if (m.type === "new_route" && m.feature) {
          routeRef.current = m.feature;
          setRoute(m.feature);
          if (Array.isArray(m.destination) && m.destination.length === 2) {
            setDestination([m.destination[0], m.destination[1]]);
          }
          // A reroute mid-drive (or the server's auto-reroute) swaps the active
          // line without leaving navigation. A fresh route enters PREVIEW: show
          // the whole trip and wait for GO instead of auto-starting.
          if (m.rerouted || phaseRef.current === "driving") {
            const p = m.feature.properties ?? {};
            setNotice(m.rerouted && p.durationS != null ? `rerouted · ${fmtDuration(p.durationS)}` : null);
          } else {
            setPendingRoute(m.feature);
            setNavPhase("preview");
            setSuggestions([]);
            Keyboard.dismiss();
          }
          askRecents(); // the server just recorded this destination in history
        } else if (m.type === "suggestions") {
          // ignore answers to a query the user has already typed past
          if (m.query === queryRef.current.trim() && Array.isArray(m.items)) {
            setSuggestions(m.items);
          }
        } else if (m.type === "category_results") {
          // Phase 17. Ignore answers for a category the user already left, the
          // same way stale suggestion frames are dropped.
          if (m.category === activeCategoryRef.current) {
            setCategoryBusy(false);
            setCategoryItems(Array.isArray(m.items) ? m.items : []);
            setCategoryError(typeof m.error === "string" ? m.error : null);
            setCategorySource(typeof m.source === "string" ? m.source : null);
          }
        } else if (m.type === "recent_searches_error") {
          // The server refused rather than pretending (Mongo down, or the
          // delete failed). Say so instead of leaving a row that would
          // reappear on the next fetch.
          setNotice("מחיקה נכשלה — נסה שוב");
        } else if (m.type === "recent_searches_results") {
          // Phase 20. Server returns up to 5 unique {name, lon, lat}, newest
          // first — or [] when Mongo is down, which just leaves the list empty.
          if (Array.isArray(m.items)) setRecent(m.items);
        } else if (m.type === "proximity_alert") {
          // Phase 21 (V2X): an active report is close ahead. This is the
          // safety-critical path — show it in every phase, not just driving.
          const label =
            REPORT_OPTIONS.find((o) => o.type === m.reportType)?.label ?? m.reportType;
          setProximity({
            reportId: String(m.reportId ?? ""),
            reportType: String(m.reportType ?? ""),
            distanceM: Number(m.distanceMeters ?? 0),
          });
          // Spoken too, so eyes stay on the road. speak() already no-ops when
          // the voice toggle is off, so this respects the existing mute.
          speak(`שים לב, ${label} במרחק ${Math.round(Number(m.distanceMeters ?? 0))} מטר.`);
        } else if (m.type === "route_signals") {
          // Phase 28. Arrives shortly AFTER new_route — never blocks it.
          if (Array.isArray(m.signals)) setSignals(m.signals);
        } else if (m.type === "route_lanes") {
          // Phase 32. Same corridor lookup as the signals, so it lands together.
          if (Array.isArray(m.samples)) setLaneSamples(m.samples);
        } else if (m.type === "nearby_drivers") {
          // Phase 24. The server already excludes us and caps the list, so this
          // is a straight swap — no merge, no diffing. Each frame is the full
          // current picture, which keeps departed drivers from lingering.
          if (Array.isArray(m.drivers)) {
            setNearbyDrivers(m.drivers);
            setNearbyAt(Date.now());
          }
        } else if (m.type === "incoming_interaction") {
          // Phase 26. Surfaced through the existing notice/toast pipeline, so
          // it shows in the sheet while idle and as a floating toast while
          // driving — no separate presentation path to maintain.
          const tier = tierFor(typeof m.fromRank === "string" ? m.fromRank : "");
          if (m.interaction === "like") {
            setNotice(`נהג בדרגת ${tier.label} פירגן לך בלייק! +1 נקודה 👍`);
          } else {
            setNotice(`נהג בדרגת ${tier.label} צפצף לך! 🎺`);
          }
        } else if (m.type === "interaction_sent") {
          setNotice(m.interaction === "like" ? "שלחת לייק 👍" : "צפרת 🎺");
        } else if (m.type === "interaction_error") {
          setNotice(m.message || "השליחה נכשלה");
        } else if (m.type === "saved_places") {
          // Phase 25. Full list every time — replace, never patch.
          if (Array.isArray(m.places)) setSavedPlaces(m.places);
          if (m.saved) setNotice(`נשמר: ${m.saved}`);
          else if (m.deleted) setNotice("המקום נמחק");
        } else if (m.type === "place_error") {
          setNotice(m.message || "שמירת המקום נכשלה");
        } else if (m.type === "profile_results") {
          // Phase 22. `persisted:false` means the server answered but Mongo was
          // down — a zeroed fallback, not a real "you have 0 points" result, so
          // the sheet distinguishes the two rather than discouraging the driver.
          setProfileBusy(false);
          setProfile({
            points: Number(m.points ?? 0),
            totalDistanceKm: Number(m.totalDistanceKm ?? 0),
            rank: typeof m.rank === "string" && m.rank ? m.rank : RANK_TIERS[0].key,
            savedPlaces: Array.isArray(m.savedPlaces) ? m.savedPlaces : [],
            persisted: m.persisted !== false,
          });
          if (Array.isArray(m.savedPlaces)) setSavedPlaces(m.savedPlaces);
        } else if (m.type === "traffic_report") {
          // A crowd report. The server marks history it replays on connect with
          // replay:true — render those SILENTLY. Without this check every
          // reconnect (Metro reload, network flap, app restart) re-announced
          // every still-active report as brand new, which looks exactly like a
          // phantom jam firing while you sit still at home.
          //
          // Phase 34: live OR replayed, every valid report also becomes a MAP
          // PIN, so drivers can see it in place and vote on whether it's still
          // there. Deduped by id, pruned by the shared TTL, capped so a long
          // session can't grow the list without bound.
          const loc = m.location;
          if (typeof m.id === "string" && Array.isArray(loc) && loc.length === 2) {
            const rep: ActiveReport = {
              id: m.id,
              reportType: String(m.reportType ?? ""),
              lon: Number(loc[0]),
              lat: Number(loc[1]),
              ts: Number(m.ts ?? Date.now()),
            };
            setActiveReports((prev) => {
              const cutoff = Date.now() - REPORT_PIN_TTL_MS;
              const next = prev.filter((r) => r.id !== rep.id && r.ts >= cutoff);
              next.push(rep);
              return next.length > 100 ? next.slice(next.length - 100) : next;
            });
          }
          if (!m.replay) {
            const label =
              REPORT_OPTIONS.find((o) => o.type === m.reportType)?.label ?? m.reportType;
            setNotice(`דיווח חדש בקרבת מקום: ${label}`);
          }
        } else if (m.type === "report_removed") {
          // Phase 34: the crowd retired it — every client drops the pin at
          // once, and an open vote popup for it closes rather than letting the
          // driver vote on a ghost.
          const gone = String(m.reportId ?? "");
          setActiveReports((prev) => prev.filter((r) => r.id !== gone));
          setVoteTarget((v) => (v && v.id === gone ? null : v));
        } else if (m.type === "vote_ack") {
          setNotice(m.counted ? "תודה! הדיווח עודכן" : "כבר הצבעת על הדיווח הזה");
        } else if (m.type === "vote_error") {
          setNotice("ההצבעה נכשלה — הדיווח כבר לא פעיל");
        } else if (m.type === "report_ack") {
          setNotice("הדיווח התקבל, תודה!");
        } else if (m.type === "report_error") {
          setNotice(`הדיווח נכשל: ${m.message}`);
        } else if (m.type === "route_error") {
          setNotice(`routing failed: ${m.message}`);
        }
      } catch {
        // ignore malformed frames
      }
    };
    ws.onerror = () => {
      // onclose always follows an error; reconnect is scheduled there
    };
    ws.onclose = () => {
      setConnected(false);
      setNearbyDrivers([]); // don't leave a frozen crowd on the map
      if (!mounted.current) return;
      reconnectTimer.current = setTimeout(connect, retryMsRef.current);
      retryMsRef.current = Math.min(retryMsRef.current * 2, 15000);
    };
    // speak is a stable useCallback([]) — listing it can't cause a reconnect loop.
  }, [wsUrl, setNavPhase, speak, DEVICE_ID]);

  useEffect(() => {
    mounted.current = true;
    connect();
    return () => {
      mounted.current = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  // shared send path: deliver now if the link is up, otherwise buffer
  const sendJson = useCallback((obj: Record<string, unknown>) => {
    const msg = JSON.stringify(obj);
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    } else {
      queueRef.current.push(msg); // offline: buffer, flush on reconnect
      if (queueRef.current.length > 500) queueRef.current.shift();
    }
  }, []);

  const sendPing = useCallback(
    (loc: Location.LocationObject) => {
      sendJson({
        deviceId: DEVICE_ID,
        lon: loc.coords.longitude,
        lat: loc.coords.latitude,
        speed: loc.coords.speed, // m/s; -1 on iOS when unknown
        heading: loc.coords.heading,
        accuracy: loc.coords.accuracy,
        ts: loc.timestamp,
      });
    },
    [sendJson, DEVICE_ID]
  );

  // Phase 15: submit a traffic report over the SAME socket as everything else.
  // sendJson gives us the offline queue for free — a report tapped in a dead
  // zone is delivered on reconnect. Location comes from the live fix; the
  // server also falls back to this device's last ping if we omit it.
  const submitReport = useCallback(
    (reportType: string) => {
      console.log(`Report submitted: ${reportType}`);
      const f = fixRef.current;
      sendJson({
        type: "traffic_report",
        deviceId: DEVICE_ID,
        reportType,
        location: f ? [f.coords.longitude, f.coords.latitude] : undefined,
      });
      setNotice("הדיווח נשלח");
      setReportOpen(false);
    },
    [sendJson, DEVICE_ID]
  );

  // Phase 3: long-press -> destination -> ask the server for a route.
  // The app stays a thin client: it only names the destination; origin,
  // OSRM, and all geometry live server-side. origin is attached as a
  // fallback for the no-pings-accepted-yet edge right after a reconnect.
  const handleLongPress = useCallback(
    (e: NativeSyntheticEvent<PressEvent>) => {
      const lngLat = e.nativeEvent?.lngLat;
      if (!Array.isArray(lngLat) || lngLat.length !== 2) return;
      const dest: [number, number] = [lngLat[0], lngLat[1]];
      setDestination(dest);
      setNotice("routing…");
      const f = fixRef.current;
      sendJson({
        type: "set_destination",
        deviceId: DEVICE_ID,
        destination: dest,
        origin: f ? [f.coords.longitude, f.coords.latitude] : undefined,
        profile: vehicleRef.current,
      });
      lastDestRef.current = { lon: dest[0], lat: dest[1] };
    },
    [sendJson, DEVICE_ID]
  );

  // Phase 5: autocomplete. Keystrokes are debounced 500 ms, need >=3 chars,
  // and are answered by the SERVER (which gates Nominatim to 1 req/s and
  // caches — the public endpoint forbids raw search-as-you-type).
  const onQueryChange = useCallback((text: string) => {
    queryRef.current = text;
    setQuery(text);
  }, []);

  // Stable clear handler. An inline `() => onQueryChange("")` would be a new
  // function identity every render, defeating SearchBar's memo entirely.
  const clearQuery = useCallback(() => {
    queryRef.current = "";
    setQuery("");
  }, []);

  useEffect(() => {
    if (suppressSuggestRef.current) {
      suppressSuggestRef.current = false;
      return;
    }
    const q = query.trim();
    if (q.length < 3) {
      setSuggestions([]);
      return;
    }
    const timer = setTimeout(() => {
      sendJson({ type: "search_suggest", deviceId: DEVICE_ID, query: q });
    }, 500);
    return () => clearTimeout(timer);
  }, [query, sendJson, DEVICE_ID]);

  // Tapping a suggestion routes by COORDINATES — no second geocode ever fires.
  // EXCEPT in save-mode (Phase 25): when the driver tapped an empty Home/Work
  // chip we're collecting an address, so the pick is stored instead of driven
  // to. One branch at the top keeps every caller (tap, Enter, top-suggestion)
  // on the same rule without duplicating it.
  const chooseSuggestion = useCallback(
    (s: Suggestion) => {
      suppressSuggestRef.current = true;
      const label = s.detail ? `${s.name}, ${s.detail}` : s.name;

      const saveAs = pendingSaveLabelRef.current;
      if (saveAs) {
        pendingSaveLabelRef.current = null;
        setPendingSaveLabel(null);
        setQuery("");
        queryRef.current = "";
        setSuggestions([]);
        Keyboard.dismiss();
        sendJson({
          type: "save_place",
          deviceId: DEVICE_ID,
          label: saveAs,
          address: label,
          lat: s.lat,
          lon: s.lon,
        });
        return; // saved, not routed
      }

      queryRef.current = label;
      setQuery(label);
      setSuggestions([]);
      Keyboard.dismiss();
      setDestination([s.lon, s.lat]);
      setNotice("routing…");
      const f = fixRef.current;
      sendJson({
        type: "set_destination",
        deviceId: DEVICE_ID,
        destination: [s.lon, s.lat],
        destinationName: label,
        origin: f ? [f.coords.longitude, f.coords.latitude] : undefined,
        profile: vehicleRef.current,
      });
      lastDestRef.current = { lon: s.lon, lat: s.lat, name: label };
    },
    [sendJson, DEVICE_ID]
  );

  // Clear the category view and go back to the recents list.
  const clearCategory = useCallback(() => {
    activeCategoryRef.current = null;
    setActiveCategory(null);
    setCategoryItems([]);
    setCategoryError(null);
    setCategorySource(null);
    setCategoryBusy(false);
  }, []);

  // Phase 17: tap a chip -> ask the server for nearby POIs of that category.
  // Tapping the ACTIVE chip again toggles the panel closed. Coordinates come
  // from the live fix; if there isn't one yet we omit them and the server falls
  // back to this device's last ping (undefined keys are dropped by stringify).
  const onCategoryPress = useCallback(
    (key: string) => {
      if (activeCategoryRef.current === key) {
        clearCategory();
        return;
      }
      activeCategoryRef.current = key;
      setActiveCategory(key);
      setCategoryItems([]);
      setCategoryError(null);
      setCategoryBusy(true);
      setSuggestions([]);
      Keyboard.dismiss();
      const f = fixRef.current;
      sendJson({
        type: "category_search",
        deviceId: DEVICE_ID,
        category: key,
        lat: f?.coords.latitude,
        lon: f?.coords.longitude,
      });
    },
    [sendJson, clearCategory, DEVICE_ID]
  );

  // One handler for both lists: category POIs and recent destinations both
  // carry {name, lon, lat}, so each routes by COORDINATES — no re-geocode.
  const routeToPlace = useCallback(
    (p: Place) => {
      clearCategory();
      chooseSuggestion({ name: p.name, detail: p.detail ?? "", lon: p.lon, lat: p.lat });
    },
    [clearCategory, chooseSuggestion]
  );

  // Phase 29: switch vehicle. If a trip is already being previewed we recompute
  // THAT trip with the new engine — a walking route and a driving route to the
  // same place are different geometry and a very different ETA, so the preview
  // has to be re-asked rather than just relabelled. Ignored mid-drive: changing
  // vehicle at 60 km/h isn't a real intent, and the server keeps the active
  // route's profile across auto-reroutes anyway.
  const chooseVehicle = useCallback(
    (next: VehicleProfile) => {
      if (next === vehicleRef.current) return;
      vehicleRef.current = next;
      setVehicle(next);
      if (phaseRef.current !== "preview") return;
      const dest = lastDestRef.current;
      if (!dest) return;
      const f = fixRef.current;
      setNotice("מחשב מסלול מחדש…");
      sendJson({
        type: "set_destination",
        deviceId: DEVICE_ID,
        destination: [dest.lon, dest.lat],
        destinationName: dest.name,
        origin: f ? [f.coords.longitude, f.coords.latitude] : undefined,
        profile: next,
      });
    },
    [sendJson, DEVICE_ID]
  );

  // Phase 50: delete ONE recent destination, on long-press. Like clearHistory
  // this is a SERVER operation — the list lives in the server's search_history
  // collection, not in AsyncStorage, so there is no local array to splice. The
  // authoritative replacement list arrives as the normal
  // recent_searches_results frame, which the existing handler already applies.
  const deleteRecentItem = useCallback(
    (place: Place) => {
      Alert.alert(
        "מחק מהיסטוריית חיפושים?",
        place.name,
        [
          { text: "ביטול", style: "cancel" },
          {
            text: "מחק",
            style: "destructive",
            onPress: () =>
              sendJson({
                type: "delete_search_history_item",
                deviceId: DEVICE_ID,
                name: place.name,
                lon: place.lon,
                lat: place.lat,
              }),
          },
        ],
        { cancelable: true }
      );
    },
    [sendJson, DEVICE_ID]
  );

  // Phase 29: wipe this device's recent destinations. The list is SERVER-side
  // (Mongo, keyed by deviceId) — not AsyncStorage, which holds only the device
  // identity that the gamification profile depends on and must not be touched.
  // The local list is cleared immediately for instant feedback; the server's
  // reply (an empty recent_searches_results) is the authoritative confirmation.
  const clearHistory = useCallback(() => {
    setRecent([]);
    sendJson({ type: "clear_search_history", deviceId: DEVICE_ID });
    setNotice("היסטוריית החיפושים נמחקה");
  }, [sendJson, DEVICE_ID]);

  // Phase 24: nearby drivers -> a GeoJSON FeatureCollection for the map.
  //
  // Rendered as data-driven LAYERS rather than one React component per driver.
  // MapLibre draws the whole set on the GPU from a single source, so 50 moving
  // markers cost one source update instead of 50 view re-renders — and unlike
  // per-marker views they don't drift behind the map while panning at 78° pitch.
  //
  // Rank colour and badge letter are baked into each feature's properties here,
  // so the style expressions can just read them with ["get", ...].
  //
  // `nowTick` is in the deps so the staleness check re-evaluates on the existing
  // 2s heartbeat — no extra timer.
  const nearbyGeoJson = useMemo(() => {
    const fresh = nearbyAt > 0 && nowTick - nearbyAt < NEARBY_STALE_MS;
    const list = fresh ? nearbyDrivers : [];
    return {
      type: "FeatureCollection" as const,
      features: list.map((d) => {
        const tier = tierFor(d.rank);
        return {
          type: "Feature" as const,
          id: d.deviceId,
          properties: {
            deviceId: d.deviceId,
            // -1 means the GPS had no course; 0 renders as a north-pointing
            // arrow, which would be a lie, so those are drawn as plain dots.
            heading: d.heading >= 0 ? d.heading : 0,
            hasHeading: d.heading >= 0 ? 1 : 0,
            rankColor: tier.color,
            rankInitial: RANK_INITIAL[d.rank] ?? "?",
          },
          geometry: { type: "Point" as const, coordinates: [d.lon, d.lat] },
        };
      }),
    };
  }, [nearbyDrivers, nearbyAt, nowTick]);

  const nearbyCount = nearbyGeoJson.features.length;

  // Phase 34: active crowd reports -> map pins. Same GPU-layer pattern as the
  // drivers: one source, data-driven styling. The colour is looked up from
  // REPORT_OPTIONS so a pin matches its tile in the report menu, and reportId
  // rides in the properties for the tap hit-test. `nowTick` keeps the TTL
  // prune live on the existing 2s heartbeat — no extra timer.
  const reportsGeoJson = useMemo(() => {
    const cutoff = nowTick - REPORT_PIN_TTL_MS;
    const fresh = activeReports.filter((r) => r.ts >= cutoff);
    return {
      type: "FeatureCollection" as const,
      features: fresh.map((r) => ({
        type: "Feature" as const,
        id: r.id,
        properties: {
          reportId: r.id,
          color: REPORT_OPTIONS.find((o) => o.type === r.reportType)?.color ?? "#F59E0B",
        },
        geometry: { type: "Point" as const, coordinates: [r.lon, r.lat] },
      })),
    };
  }, [activeReports, nowTick]);

  const reportPinCount = reportsGeoJson.features.length;

  // Phase 26: honk or like the tapped driver. Closes the bubble immediately —
  // the server's ack/error arrives as a toast, so there's nothing to wait for.
  const sendInteraction = useCallback(
    (interactionType: "honk" | "like") => {
      const target = tappedDriver;
      setTappedDriver(null);
      setTapPoint(null);
      if (!target) return;
      sendJson({
        type: "send_interaction",
        deviceId: DEVICE_ID,
        targetDeviceId: target.deviceId,
        interactionType,
      });
    },
    [tappedDriver, sendJson, DEVICE_ID]
  );

  // Phase 34: cast the "still there?" vote and close the popup immediately —
  // the server's vote_ack / report_removed arrive as their own frames, so
  // there's nothing to wait for. One vote per device is enforced server-side;
  // a duplicate just comes back counted:false.
  const sendVote = useCallback(
    (vote: "up" | "down") => {
      const target = voteTarget;
      setVoteTarget(null);
      setTapPoint(null);
      if (!target) return;
      sendJson({ type: "vote_report", deviceId: DEVICE_ID, reportId: target.id, vote });
    },
    [voteTarget, sendJson, DEVICE_ID]
  );

  // ---------- saved places actions (Phase 25) ----------
  const homePlace = savedPlaces.find((p) => p.label === HOME_LABEL) ?? null;
  const workPlace = savedPlaces.find((p) => p.label === WORK_LABEL) ?? null;
  // Favourites = everything that isn't one of the two singletons.
  const favouritePlaces = savedPlaces.filter(
    (p) => p.label !== HOME_LABEL && p.label !== WORK_LABEL
  );

  // Route straight to a stored place. Reuses the normal destination path, so
  // preview/GO/voice all behave exactly as they do for a searched destination.
  const navigateToPlace = useCallback(
    (p: SavedPlace) => {
      setPlacesOpen(false);
      setProfileOpen(false);
      setSuggestions([]);
      Keyboard.dismiss();
      setDestination([p.lon, p.lat]);
      setNotice("routing…");
      const f = fixRef.current;
      sendJson({
        type: "set_destination",
        deviceId: DEVICE_ID,
        destination: [p.lon, p.lat],
        destinationName: p.address || p.label,
        origin: f ? [f.coords.longitude, f.coords.latitude] : undefined,
        profile: vehicleRef.current,
      });
      lastDestRef.current = { lon: p.lon, lat: p.lat, name: p.address || p.label };
    },
    [sendJson, DEVICE_ID]
  );

  // Enter save-mode: the next search pick is stored under `label` rather than
  // driven to. Clearing the query gets the user straight to a fresh search.
  const beginSavePlace = useCallback((label: string) => {
    pendingSaveLabelRef.current = label;
    setPendingSaveLabel(label);
    setPlacesOpen(false);
    setProfileOpen(false);
    setQuery("");
    queryRef.current = "";
    setSuggestions([]);
    setNotice(
      label === HOME_LABEL
        ? "חפש את כתובת הבית"
        : label === WORK_LABEL
          ? "חפש את כתובת העבודה"
          : "חפש מקום לשמירה"
    );
  }, []);

  const cancelSavePlace = useCallback(() => {
    pendingSaveLabelRef.current = null;
    setPendingSaveLabel(null);
    setNotice(null);
  }, []);

  // Home/Work chip: navigate if set, otherwise start the save flow.
  const onQuickPlacePress = useCallback(
    (label: string, place: SavedPlace | null) => {
      if (place) navigateToPlace(place);
      else beginSavePlace(label);
    },
    [navigateToPlace, beginSavePlace]
  );

  const deletePlace = useCallback(
    (placeId: string) => {
      sendJson({ type: "delete_place", deviceId: DEVICE_ID, placeId });
      // Optimistic: the server replies with the authoritative list, but the row
      // disappearing instantly is what makes the tap feel responsive.
      setSavedPlaces((prev) => prev.filter((p) => p.placeId !== placeId));
    },
    [sendJson, DEVICE_ID]
  );

  // Save the destination currently being previewed as a favourite.
  const saveCurrentDestination = useCallback(() => {
    if (!destination) return;
    const name = pendingRoute?.properties?.name?.replace(/^To /, "") || "מקום שמור";
    sendJson({
      type: "save_place",
      deviceId: DEVICE_ID,
      label: name,
      address: name,
      lat: destination[1],
      lon: destination[0],
    });
  }, [destination, pendingRoute, sendJson, DEVICE_ID]);

  // ---------- traffic signals + maneuver visuals (Phase 28) ----------
  // 500ms ticker, mounted ONLY while driving: it drives the countdown digits
  // and the arrow pulse. Idle and preview pay nothing.
  useEffect(() => {
    if (phase !== "driving") return;
    const id = setInterval(() => setPulse((p) => (p + 1) % 1000), 500);
    return () => clearInterval(id);
  }, [phase]);

  // The next light AHEAD of the driver: nearest signal inside the alert radius
  // whose bearing is roughly forward. Without the bearing test the light you
  // just cleared stays "next" until you're 300m past it, which reads as a
  // countdown that never fires.
  const nextSignal = useMemo(() => {
    if (phase !== "driving" || signals.length === 0) return null;
    const f = fixRef.current;
    if (!f) return null;
    const { latitude: lat, longitude: lon, heading } = f.coords;
    const haveHeading = typeof heading === "number" && heading >= 0;
    let best: { sig: TrafficSignal; distanceM: number } | null = null;
    for (const sig of signals) {
      const distanceM = haversineM(lat, lon, sig.lat, sig.lon);
      if (distanceM > SIGNAL_ALERT_M) continue;
      if (haveHeading) {
        // ±70° cone in front. Wide enough to survive a bend in the road, tight
        // enough to exclude anything behind.
        const brg = bearingDeg(lat, lon, sig.lat, sig.lon);
        if (angleDelta(brg, heading) > 70) continue;
      }
      if (!best || distanceM < best.distanceM) best = { sig, distanceM };
    }
    return best;
    // `pulse` keeps this re-deriving as the driver moves; fixRef is a ref, so
    // it alone wouldn't trigger recomputation.
  }, [phase, signals, pulse]);

  const signalCountdown = useMemo(
    () => (nextSignal ? signalPhase(nextSignal.sig, Date.now()) : null),
    [nextSignal, pulse]
  );

  // Signals as GeoJSON, coloured by their simulated phase so the whole corridor
  // reads at a glance.
  const signalsGeoJson = useMemo(() => {
    const now = Date.now();
    return {
      type: "FeatureCollection" as const,
      features: signals.map((sig) => ({
        type: "Feature" as const,
        id: sig.id,
        properties: {
          green: signalPhase(sig, now).green ? 1 : 0,
          // Phase 34: inferred lights render dimmer — an estimate is useful,
          // but it must never be dressed up as surveyed fact.
          inferred: sig.inferred ? 1 : 0,
        },
        geometry: { type: "Point" as const, coordinates: [sig.lon, sig.lat] },
      })),
    };
  }, [signals, pulse]);

  // The stretch of route between the driver and the next turn, plus the turn
  // point itself. The server sends the maneuver's DISTANCE but not its
  // coordinates, so both are recovered by walking the route geometry we already
  // hold — no extra round-trip.
  const maneuverVisual = useMemo(() => {
    if (phase !== "driving" || !route || !status.maneuver) return null;
    const f = fixRef.current;
    if (!f) return null;
    const d = status.maneuver.distanceM;
    if (!Number.isFinite(d) || d > 900) return null; // only light it up on approach
    const coords = route.geometry.coordinates;
    const point = pointAlongRoute(coords, f.coords.latitude, f.coords.longitude, d);
    const slice = routeSliceAhead(coords, f.coords.latitude, f.coords.longitude, d);
    if (!point) return null;
    return { point, slice };
  }, [phase, route, status.maneuver, pulse]);

  // Lane guidance for the upcoming junction.
  //
  // OSM `turn:lanes` is tagged at only a minority of junctions, so real data is
  // used when present and a layout is SYNTHESISED from the road's physical lane
  // count plus the maneuver otherwise. The HUD therefore appears at every
  // significant maneuver rather than only where tagging happens to exist.
  //
  // The physical count is read at the MANEUVER's position, not the driver's —
  // the junction may be wider than the road you're currently on.
  const laneAssist = useMemo(() => {
    const m = status.maneuver;
    if (phase !== "driving" || !m || m.distanceM > LANE_ASSIST_M) return null;
    const pt = maneuverVisual?.point;
    const physical =
      pt && laneSamples.length ? lanesAt(laneSamples, pt[0], pt[1]) : null;
    return resolveLaneAssist(m.type, m.modifier, m.lanes, physical);
  }, [status.maneuver, phase, maneuverVisual, laneSamples]);

  // ---------- PHASE 51: put lane guidance on OUR side of the road ----------
  // maneuverVisual.slice follows the OSM way, which on a two-way street is the
  // ROAD centreline. The arrows and the corridor each centre themselves on the
  // line they are handed, so feeding them the raw slice laid the guidance
  // across the centre line — and because a left turn selects the LEFTMOST
  // forward lane, the green corridor rendered squarely in oncoming traffic.
  //
  // Shifting the slice once, here, fixes the arrows and the corridor together
  // and keeps them in agreement with the carriageway, which applies the
  // identical offset per span via the same helper. Declared after laneAssist
  // because it reads the resolved lane count.
  //
  // ONE shift value, shared by everything that hugs the road surface.
  //
  // It is deliberately derived from the PHYSICAL sample at the junction rather
  // than from laneAssist.lanes.length, even though the corridor draws
  // laneAssist's lane array. Two reasons. First, the beam appears at 900m
  // while laneAssist only gates in at 400m — sourcing them differently would
  // slide the beam sideways by half a carriageway the instant lane guidance
  // arrived, on every single approach. Second, both counts describe the same
  // road, so where they disagree (turn:lanes tagged with a different count
  // from `lanes`) the error is at most half a lane, against a guaranteed and
  // very visible jump. A shared value also keeps the beam concentric with the
  // corridor by construction.
  const carriageway = useMemo(() => {
    const pt = maneuverVisual?.point;
    if (!pt) return 0;
    // Direction AND count are read at the MANEUVER, from the same sample — the
    // junction may sit on a different way from the one under the car.
    const near = laneSamples.length ? nearestSample(laneSamples, pt[0], pt[1]) : null;
    //
    // PHASE 52 — the shift must NOT be coupled to Overpass.
    //
    // The first version returned 0 whenever laneSamples was empty or nothing
    // matched, which silently put the corridor back on the road centreline —
    // half of it in oncoming traffic, i.e. the exact bug Phase 51 set out to
    // fix. And empty laneSamples is not an edge case: fetchRouteCorridor
    // returns EMPTY_CORRIDOR every time the Overpass breaker is open, which is
    // precisely the coupling inferredTrafficLights.js was written to break for
    // the lights. Same mistake, same fix — degrade to an assumption instead of
    // degrading to "wrong side of the road".
    //
    // Unknown direction means TWO-WAY, matching the server's own default: it
    // puts us on the right-hand carriageway, where a driver actually is.
    // Assuming oneway would straddle the centre line, which is the worse error.
    const oneway = near ? !!near.oneway : false;
    //
    // PHASE 53 — count comes from laneAssist FIRST, not from the sample.
    //
    // The shift has to be half the width of the lane array that is actually
    // rendered, because that array is centred on the line we hand it. Phase 52
    // preferred the physical sample so the beam wouldn't jump at 400m, but the
    // two counts can disagree: OSRM turn:lanes may report 2 lanes where the
    // OSM `lanes` tag (or its default) says 1. Shifting by 1.8m while drawing
    // a 2-lane array leaves the array spanning -1.15m..+1.15m — straddling the
    // centre line, with its left lane in oncoming traffic. That is the bug
    // surviving into a third report. Aligning the corridor correctly matters
    // more than a soft glow moving; the beam is hidden once the corridor
    // appears anyway, so there is no longer a jump to protect against.
    //
    // PHASE 54 — the count comes from the PHYSICAL road again, and this time the
    // guidance is projected onto it rather than drawn to its own width.
    //
    // Phase 53 switched this to laneAssist.lanes.length to stop the shift and
    // the ribbon disagreeing. That fixed the shift but left the ribbon indexed
    // against a carriageway that isn't the one drawn: the asphalt, the dividers
    // and the edge lines all come from `near.lanes`, so a 2-lane turn:lanes
    // array on a 1-lane road put the right-hand ribbon at 4.25..6.55m against
    // asphalt ending at 3.6m — off the road entirely, hard against the edge
    // line. Sourcing BOTH from the physical count and folding the guidance onto
    // it (mapLanesOntoCarriageway) makes the two agree by construction.
    //
    // PHASE 55: the SHIFT no longer lives here. drivingCentreline resolves the
    // offset per vertex, so a single value measured at the maneuver would only
    // be a second, staler opinion about the same thing. What survives is the
    // lane COUNT, which the guidance is folded onto.
    void oneway;
    return { lanes: near?.lanes ?? LANE_COUNT_FALLBACK };
  }, [maneuverVisual, laneSamples]);

  /**
   * laneAssist folded onto the lanes actually drawn. Everything painted on the
   * road — ribbon and arrows — indexes against THIS, never the raw guidance
   * array, so it cannot address a lane the carriageway doesn't have.
   */
  const carriagewayLanes = useMemo(() => {
    if (!laneAssist) return null;
    const mapped = mapLanesOntoCarriageway(laneAssist.lanes, carriageway.lanes);
    return mapped.length ? mapped : null;
  }, [laneAssist, carriageway.lanes]);

  /** The maneuver stretch, moved onto the carriageway we're actually driving. */
  const drivingSlice = useMemo(() => {
    const raw = maneuverVisual?.slice as [number, number][] | undefined;
    if (!raw || raw.length < 2) return null;
    //
    // PHASE 55: resolved PER VERTEX, not once for the whole slice.
    //
    // This used to apply carriageway.shiftM — measured from the single sample
    // nearest the maneuver — uniformly across all 250m. buildCarriageway has
    // always offset per span, so the moment a slice crossed a change (a two-way
    // street feeding a one-way roundabout being the common case) the asphalt
    // switched sides at the seam and this ribbon did not. It began on the
    // correct side and drifted across the centre line on the approach, because
    // its shift described the road at the far end rather than the road under
    // the wheels.
    const line = drivingCentreline(
      raw,
      laneSamples,
      LANE_COUNT_FALLBACK,
      3.6
    ) as [number, number][];
    return line.length >= 2 ? line : raw;
  }, [maneuverVisual, laneSamples]);

  // The countdown card stacks BELOW the HUD, so both must agree on this.
  const laneAssistVisible = !!laneAssist;

  // ---------- driving-mode top stack geometry (Phase 45) ----------
  // The maneuver banner, the lane HUD and the signal countdown card form one
  // vertical stack. That base offset used to be written out as the literal
  // `Platform.OS === "ios" ? 104 : 88` in THREE separate places, so the stack
  // was only aligned as long as all three copies stayed in step — and none of
  // them derived from the safe area, unlike every other top-anchored element in
  // the app. One derived value now feeds all three.
  const topStackTop = insets.top + 12 + (proximity ? 86 : 0);
  // PHASE 48: the guidance group's real height, so anything below it tracks the
  // attached lane box instead of assuming a fixed step. Previously the signal
  // card stepped by a flat 104 per element, which was tuned when the lane HUD
  // floated separately with its own 10px gap; now that it's flush inside the
  // group the measured heights are what matter.
  const GUIDANCE_BANNER_H = 92; // 62 glyph box + 15 padding top and bottom
  const LANE_BOX_H = 76; // lane row + footer + 10 padding top and bottom
  //
  // PHASE 50 — MEASURE the group instead of predicting it.
  //
  // Those two constants are estimates, and the field screenshots show the
  // signal countdown card sliding UNDER the banner: once the banner and lane
  // box were unified into one shell (Phase 48) the real height stopped
  // matching the arithmetic. It was always going to — the banner wraps Hebrew
  // street names to a second line, font scaling moves it, and the lane box
  // grows with the lane count. Any fixed number is wrong for some junction.
  //
  // onLayout reports what was ACTUALLY laid out, so the card tracks the group
  // whatever it contains. The constants survive only as the first-frame
  // fallback, before any layout pass has happened.
  const [measuredGroupH, setMeasuredGroupH] = useState<number | null>(null);
  const onGuidanceGroupLayout = useCallback((e: LayoutChangeEvent) => {
    const h = Math.round(e.nativeEvent.layout.height);
    // Ignore 0-height passes (they happen while the group is unmounting) and
    // sub-pixel churn, which would otherwise re-render on every frame.
    setMeasuredGroupH((prev) => (h > 0 && (prev === null || Math.abs(prev - h) >= 1) ? h : prev));
  }, []);
  // Drop the stale measurement the moment the group's CONTENT changes, so one
  // frame of a too-low card can't appear when the lane box comes or goes.
  useEffect(() => {
    setMeasuredGroupH(null);
  }, [laneAssistVisible, phase]);
  const guidanceGroupH =
    measuredGroupH ?? GUIDANCE_BANNER_H + (laneAssistVisible ? LANE_BOX_H : 0);

  // ---------- driving-mode bottom stack geometry (Phase 46 / 48) ----------
  // PHASE 48 splits the bottom into two independent columns so the middle of the
  // screen — the road — stays clear:
  //
  //   LEFT   speedometer + its limit sign, on the bottom edge
  //   RIGHT  metrics pill on the bottom edge, then the status chip, then the
  //          recenter button stacked above it
  //
  // Phase 46 had a full-width bar on the bottom edge which forced everything
  // else upward and ate a band of road across the whole screen.
  const bottomEdge = insets.bottom + TRIP_DASH_GAP;
  const rightRow2 = bottomEdge + TRIP_PILL_H + 10;      // status chip
  const rightRow3 = rightRow2 + 34 + 10;                // recenter button
  // Toast clears whichever column is taller.
  const toastBottomDriving =
    Math.max(rightRow3 + 54, bottomEdge + SPEEDO_STACK_H) + 12;

  // Phase 35: ON-ROAD LANE ARROWS — the Gaode/Baidu ground-paint signature.
  // One arrow per lane, stamped flat on the asphalt in two rows before the
  // junction (25m and 60m out, the way real markings repeat), each rotated by
  // that lane's indication using the SAME angle table as the HUD — so the
  // road and the HUD can never disagree about which lane does what. Anchored
  // to the maneuver end of the slice, the arrows hold still in world space
  // like real paint, and a row the driver has already passed simply drops.
  // See lib/laneArrows.ts for why these are fill POLYGONS rather than symbol
  // glyphs or icons (glyph-range and sprite constraints; geometry IS paint
  // and foreshortens correctly at the 80° pitch for free).
  const laneArrows = useMemo(() => {
    if (!carriagewayLanes || !drivingSlice || drivingSlice.length < 2) return null;
    const specs = carriagewayLanes.map((ln) => ({
      valid: ln.valid,
      angleDeg: laneArrowAngle(ln),
    }));
    const fc = buildLaneArrows(
      drivingSlice, // Phase 51: our carriageway, not the road centreline
      specs,
      3.6, // must match buildCarriageway's lane width, or arrows drift off-lane
      [25, 60]
    );
    return fc.features.length ? fc : null;
  }, [carriagewayLanes, drivingSlice]);

  // ---------- highlighted lane corridor (Phase 39) ----------
  // The continuous ribbon over the lane(s) that serve the next maneuver — the
  // "active path" the driver follows without reading anything. Same laneAssist
  // array and same 3.6m lane width as the arrows above, so the ribbon and the
  // arrows always agree about where a lane is.
  //
  // Returns null for straight-ahead and single-lane maneuvers: laneAssist marks
  // every lane valid there, and a ribbon covering the whole carriageway
  // distinguishes nothing. buildLaneCorridor enforces that rule itself; the
  // null here just skips the source entirely so no empty layer mounts.
  const laneCorridor = useMemo(() => {
    if (!carriagewayLanes || !drivingSlice || drivingSlice.length < 2) return null;
    const c = buildLaneCorridor(
      drivingSlice, // Phase 51: our carriageway, not the road centreline
      carriagewayLanes, // Phase 54: the lanes actually drawn, not raw turn:lanes
      3.6 // must match buildCarriageway and buildLaneArrows
    );
    return c.core.features.length ? c : null;
  }, [carriagewayLanes, drivingSlice]);

  // ---------- route ribbon yields to the corridor (Phase 41) ----------
  // Two pieces of guidance were competing for the same asphalt: the blue route
  // ribbon runs down the centreline, the green corridor covers the valid lane,
  // and where they overlap the blend is a muddy teal that reads as neither.
  // Gaode and Baidu resolve this by letting the route line become subordinate
  // once lane-level guidance takes over — the corridor IS the route at that
  // point, so drawing both at full strength is redundant as well as ugly.
  //
  // 0 = ribbon at full strength, 1 = fully deferred to a hairline.
  //
  // The ramp is driven by DISTANCE TO THE MANEUVER, not by a timer. That
  // matters for smoothness: this component's ticker only fires every 500ms, so
  // a time-based tween would visibly step in 2-3 frames. Distance updates on
  // every GPS fix instead, so the ramp resolves finely enough to read as
  // continuous.
  //
  // PHASE 42 CORRECTION. This ramp originally ran 900m -> 400m, on the belief
  // that the corridor first appears at the maneuverVisual gate (900m). It does
  // not: laneArrows and laneCorridor both hang off laneAssist, which is gated
  // at LANE_ASSIST_M = 400. So the old ramp evaluated to 0 at 401m (corridor
  // absent, nothing to defer to) and to a full 1.0 at 400m (corridor mounts) —
  // the ribbon collapsed to a hairline in a single GPS tick, which is exactly
  // the jump the ramp was supposed to prevent.
  //
  // It now spans the range where the corridor actually exists: untouched at
  // 400m where the corridor arrives, fully deferred by 250m.
  const routeYield = useMemo(() => {
    if (!laneArrows || !laneCorridor) return 0;
    const d = status.maneuver?.distanceM;
    if (!Number.isFinite(d)) return 0;
    return Math.max(0, Math.min(1, (LANE_ASSIST_M - (d as number)) / (LANE_ASSIST_M - 250)));
  }, [laneArrows, laneCorridor, status.maneuver]);

  /** Linear blend used to drive the ribbon's paint off routeYield. */
  const yieldTo = (normal: number, deferred: number) =>
    normal + (deferred - normal) * routeYield;

  // ---------- PHASE 50: the ribbon gets out of the corridor's way ----------
  // Phase 41 deferred the WHOLE ribbon to a hairline as the corridor lit up,
  // and its own note named the cost: that answers "which lane" at the expense
  // of "where next". Hiding the layer outright (line-opacity 0) pays the same
  // cost in full — at 80° pitch the route beyond the turn is most of the
  // screen. line-opacity is per-layer, but line-gradient is per-POSITION, and
  // this source already sets lineMetrics. So the ribbon is made transparent
  // across EXACTLY the corridor's span and left at full strength everywhere
  // else: the green replaces the blue where they overlapped, and the route
  // after the junction is untouched.
  //
  // Quantised to 0.1% of route length so a gradient texture isn't re-uploaded
  // for sub-pixel movement on every GPS fix.
  const ribbonHole = useMemo(() => {
    const q = (v: number) => Math.round(v * 1000) / 1000;
    const h = corridorHole(
      route?.properties?.lengthM ?? null,
      status.remainingM,
      status.maneuver?.distanceM ?? null,
      laneCorridor ? routeYield : 0
    );
    return h ? { t0: q(h.t0), t1: q(h.t1), strength: Math.round(h.strength * 20) / 20 } : null;
  }, [route, status.remainingM, status.maneuver, laneCorridor, routeYield]);

  // gradientWithHole builds its stop list at runtime, so its return type is a
  // widened array. MapLibre's paint typing is a strict tuple UNION that only a
  // literal can be inferred into — no variadic builder can satisfy it, and
  // maplibre-style-spec isn't a resolvable direct import here. One cast, in
  // one place, rather than `any` sprinkled across four layers. The expression's
  // SHAPE is what matters and it is asserted directly in routeGradient's unit
  // tests (top-level interpolate, ["line-progress"] input, stops strictly
  // increasing and within 0..1) — stronger checking than the tuple type gives.
  const asPaintExpr = (e: ReturnType<typeof gradientWithHole>) =>
    e as unknown as ExpressionSpecification;

  // PHASE 52: the per-segment hole is the GOOD path — it hides the ribbon
  // exactly where the corridor covers it and keeps the route beyond the turn.
  // But it needs route length and remaining distance, and if either is missing
  // corridorHole returns null and the blue ribbon stays fully visible next to
  // the green — which is what the field report kept showing. When the corridor
  // is up and no hole could be computed, hide the ribbon outright instead.
  // Losing the far-field line in that fallback is the lesser evil against two
  // guidance elements fighting over the same asphalt.
  const ribbonFullyHidden = !!laneCorridor && !ribbonHole;

  /** Constant-colour ribbon layer, with the corridor span punched out. */
  const holedSolid = useCallback(
    (color: string) => asPaintExpr(gradientWithHole([[0, color], [1, color]], ribbonHole)),
    [ribbonHole]
  );

  // 0..1 triangle wave from the ticker, used for the glow pulse.
  const pulseT = (pulse % 4) / 4;
  const pulseWave = pulseT < 0.5 ? pulseT * 2 : (1 - pulseT) * 2;

  // ---------- lane-level carriageway + 3D beacons (Phase 31) ----------
  // The route is drawn as a ROAD rather than a line: asphalt, edge lines and
  // dashed lane dividers, all derived from the centreline. Bounded to the next
  // 350m because that's the only part legible at navigation zoom — synthesising
  // it for the whole route would recompute thousands of vertices per fix.
  const lanes = useMemo(() => {
    if (phase !== "driving" || !route) return null;
    const f = fixRef.current;
    if (!f) return null;
    const ahead = routeAhead(
      route.geometry.coordinates as [number, number][],
      f.coords.latitude,
      f.coords.longitude,
      350
    );
    if (ahead.length < 2) return null;
    // Split the visible stretch into runs of constant lane count, then build a
    // carriageway per run — so the road physically narrows and widens with the
    // real OSM data instead of assuming a uniform width.
    const spans = splitByLanes(ahead, laneSamples, LANE_COUNT_FALLBACK);
    return buildCarriageway(spans, 3.6);
    // `pulse` advances every 500ms while driving, so the carriageway keeps up
    // with the vehicle without needing its own timer.
  }, [phase, route, pulse, laneSamples]);

  // Extruded beacon standing on the road at the next turn, plus a gantry slab
  // spanning the carriageway. Symbols always face the camera or lie flat;
  // fill-extrusion is the only thing that genuinely occupies height in the
  // scene, which is what makes these read as physically present.
  const beacon = useMemo(() => {
    if (!maneuverVisual) return null;
    const [lon, lat] = maneuverVisual.point;
    const brg = headingOf((drivingSlice ?? maneuverVisual.slice) as [number, number][]);
    return {
      pillar: {
        type: "Feature" as const,
        properties: {},
        geometry: circlePolygon(lon, lat, 5.5, 20),
      },
      gantry: {
        type: "Feature" as const,
        properties: {},
        geometry: crossbarPolygon(lon, lat, brg, 16, 2.2),
      },
    };
  }, [maneuverVisual]);

  // Phase 22: open the profile sheet and ask for fresh stats. The sheet opens
  // immediately (cached values stay on screen) and fills in when the server
  // answers — so a slow or absent DB shows a loading state, never a blank modal.
  const openProfile = useCallback(() => {
    setProfileOpen(true);
    setProfileBusy(true);
    sendJson({ type: "get_profile", deviceId: DEVICE_ID });
  }, [sendJson, DEVICE_ID]);

  // Enter/submit: take the top suggestion when one exists, otherwise fall
  // back to a plain server-side geocode of the raw text.
  const submitSearch = useCallback(() => {
    if (suggestions.length > 0) {
      chooseSuggestion(suggestions[0]);
      return;
    }
    const q = query.trim();
    if (!q) return;
    Keyboard.dismiss();
    setSuggestions([]);
    setNotice(`searching "${q}"…`);
    const f = fixRef.current;
    sendJson({
      type: "set_destination",
      deviceId: DEVICE_ID,
      query: q,
      origin: f ? [f.coords.longitude, f.coords.latitude] : undefined,
      profile: vehicleRef.current,
    });
  }, [query, suggestions, chooseSuggestion, sendJson, DEVICE_ID]);

  // Tapping the map closes the keyboard and the dropdown so it never blocks.
  const dismissSearch = useCallback(() => {
    Keyboard.dismiss();
    setSuggestions([]);
  }, []);

  // Phase 26/27: map tap = "did I hit another driver?", else the old dismiss.
  //
  // TWO detectors, tried in order, because either alone has a failure mode:
  //
  //   1. queryRenderedFeaturesAtPoint — asks MapLibre what is actually drawn
  //      under the finger. Most precise, and it respects the real rendered
  //      marker rather than an approximation.
  //   2. Geographic fallback — haversine from the tap's lngLat to each driver
  //      we already hold in state, with a tolerance derived from live zoom so
  //      the target stays finger-sized at any scale.
  //
  // (1) can silently return EMPTY if this MapLibre generation names the screen
  // point differently or shapes the result differently — indistinguishable from
  // "nothing there", so a try/catch alone would never notice. Running (2)
  // whenever (1) finds nothing means a wrong guess about the native API costs
  // precision, never the feature.
  const nearbyRef = useRef<NearbyDriver[]>([]);
  useEffect(() => {
    nearbyRef.current = nearbyDrivers;
  }, [nearbyDrivers]);

  // Same ref-mirror as the drivers: the tap handler is a stable callback and
  // must read the CURRENT pin list, not the one from its creation render.
  const activeReportsRef = useRef<ActiveReport[]>([]);
  useEffect(() => {
    activeReportsRef.current = activeReports;
  }, [activeReports]);

  const handleMapPress = useCallback(
    async (e: NativeSyntheticEvent<PressEvent>) => {
      const ne = e.nativeEvent as unknown as Record<string, any> | undefined;
      const list = nearbyRef.current;
      const reps = activeReportsRef.current;
      if (list.length === 0 && reps.length === 0) {
        dismissSearch();
        return;
      }

      // Screen point, probed across the shapes different generations use.
      const sx = ne?.screenPointX ?? ne?.point?.x ?? ne?.properties?.screenPointX;
      const sy = ne?.screenPointY ?? ne?.point?.y ?? ne?.properties?.screenPointY;
      const hasPoint = typeof sx === "number" && typeof sy === "number";

      let hit: NearbyDriver | null = null;

      // ---- 1. native rendered-feature query ----
      if (hasPoint && list.length > 0 && mapRef.current?.queryRenderedFeaturesAtPoint) {
        try {
          const res: any = await mapRef.current.queryRenderedFeaturesAtPoint(
            [sx, sy],
            null,
            ["drivers-body", "drivers-halo"]
          );
          const id = res?.features?.[0]?.properties?.deviceId;
          if (id) hit = list.find((d) => d.deviceId === id) ?? null;
        } catch {
          /* unsupported or different signature — the fallback covers us */
        }
      }

      // ---- 2. geographic fallback ----
      if (!hit && list.length > 0) {
        const lngLat = ne?.lngLat;
        if (Array.isArray(lngLat) && lngLat.length === 2) {
          const [tapLon, tapLat] = lngLat;
          const mPerPx =
            (MERCATOR_M_PER_PX_Z0 * Math.cos((tapLat * Math.PI) / 180)) /
            Math.pow(2, zoomRef.current);
          const toleranceM = Math.max(25, mPerPx * DRIVER_TAP_RADIUS_PX);
          let bestD = Infinity;
          let best: NearbyDriver | null = null;
          for (const d of list) {
            const dist = haversineM(tapLat, tapLon, d.lat, d.lon);
            if (dist < bestD) {
              bestD = dist;
              best = d;
            }
          }
          if (best && bestD <= toleranceM) hit = best;
        }
      }

      if (hit) {
        Keyboard.dismiss();
        setSuggestions([]);
        // Remember where the finger landed so the bubble can open there rather
        // than in the middle of the screen, away from the car it refers to.
        setTapPoint(hasPoint ? { x: sx, y: sy } : null);
        setTappedDriver(hit);
        return;
      }

      // ---- report pin? (Phase 34: tap -> "עדיין שם?" vote) ----
      // Same two-detector strategy as the drivers: rendered-feature query
      // first, geographic fallback second, so a wrong guess about the native
      // API costs precision, never the feature.
      if (reps.length > 0) {
        let rep: ActiveReport | null = null;
        if (hasPoint && mapRef.current?.queryRenderedFeaturesAtPoint) {
          try {
            const res: any = await mapRef.current.queryRenderedFeaturesAtPoint(
              [sx, sy],
              null,
              ["reports-pin", "reports-halo"]
            );
            const id = res?.features?.[0]?.properties?.reportId;
            if (id) rep = reps.find((r) => r.id === id) ?? null;
          } catch {
            /* unsupported or different signature — the fallback covers us */
          }
        }
        if (!rep) {
          const lngLat = ne?.lngLat;
          if (Array.isArray(lngLat) && lngLat.length === 2) {
            const [tapLon, tapLat] = lngLat;
            const mPerPx =
              (MERCATOR_M_PER_PX_Z0 * Math.cos((tapLat * Math.PI) / 180)) /
              Math.pow(2, zoomRef.current);
            const toleranceM = Math.max(25, mPerPx * DRIVER_TAP_RADIUS_PX);
            let bestD = Infinity;
            let best: ActiveReport | null = null;
            for (const r of reps) {
              const d = haversineM(tapLat, tapLon, r.lat, r.lon);
              if (d < bestD) {
                bestD = d;
                best = r;
              }
            }
            if (best && bestD <= toleranceM) rep = best;
          }
        }
        if (rep) {
          Keyboard.dismiss();
          setSuggestions([]);
          setTapPoint(hasPoint ? { x: sx, y: sy } : null);
          setVoteTarget(rep);
          return;
        }
      }
      dismissSearch();
    },
    [dismissSearch]
  );

  // Phase 6/10: the camera driver. Imperative easeTo/flyTo on every fix. The
  // full {center,zoom,pitch,bearing} tuple is ALWAYS sent in nav mode so pitch
  // can never drift flat. Ease duration is kept under the ping interval so each
  // move settles before the next, and bearing is smoothed so a noisy GPS
  // heading can't spin the view.
  // Extreme, immersive perspective — the "racing game" camera. 80° is at the
  // top of what MapLibre Native accepts; past that the horizon leaves the
  // viewport entirely and the road ahead compresses to nothing. Higher zoom
  // puts the camera lower and closer to the asphalt, which is what makes the
  // lane markings and the 3D beacon feel like they're rushing toward you.
  //
  // ---------------------------------------------------------------------
  // PHASE 43: pitch and zoom are no longer fixed. A static 80° is superb for
  // reading lane geometry at a junction and poor for everything else — on a
  // long cruise it buries the road ahead at the bottom of the viewport and
  // gives the driver almost no forward context.
  //
  // The camera now interpolates between two poses on distance to the next
  // maneuver:
  //
  //   CRUISE   (>= 800m, or no maneuver)  55° / z17.2 — road ahead visible,
  //                                       more of the route on screen
  //   APPROACH (<= 400m)                  80° / z18   — the original immersive
  //                                       pose, where the corridor and the
  //                                       ground arrows actually read
  //
  // WHY THE RAMP ENDS AT 400m RATHER THAN CLOSER: LANE_ASSIST_M is 400, so that
  // is exactly where the lane HUD, the ground arrows and the green corridor
  // arrive. The camera is therefore already fully immersive at the moment there
  // is detailed geometry to look at, instead of still tilting up while the
  // driver is trying to choose a lane.
  //
  // SMOOTHNESS comes from three things:
  //   1. the ramp is a continuous function of distance, so it moves a little on
  //      every fix instead of switching state at a threshold;
  //   2. the value is exponentially smoothed in a ref, so a reroute — which can
  //      jump distanceM by hundreds of metres — bleeds in over several fixes
  //      instead of snapping the horizon;
  //   3. each fix still eases over 600ms, so the pose glides rather than cuts.
  // At 50km/h the 800→400m band is roughly 14 fixes, about 1.8° of pitch per
  // tick, which is below the point where tilt reads as a step.
  const NAV_ZOOM = 18;
  const NAV_PITCH = 80;
  const CRUISE_ZOOM = 17.2;
  const CRUISE_PITCH = 55;
  const CAM_FAR_M = 800;   // fully cruising at or beyond this
  const CAM_NEAR_M = LANE_ASSIST_M; // fully immersive once lane guidance exists
  const CAM_SMOOTH = 0.35; // per-fix approach toward the target ramp
  const driveCamera = useCallback((loc: Location.LocationObject, fly = false) => {
    const cam = cameraRef.current;
    const mode = cameraModeRef.current;
    if (!cam || mode === "free") return;
    const speed = loc.coords.speed ?? -1;
    const heading = loc.coords.heading ?? -1;
    if (mode === "nav" && speed > 0.8 && heading >= 0) {
      // shortest-arc smoothing toward the new heading (avoids 359°→1° spins)
      const prev = lastBearingRef.current;
      let delta = ((heading - prev + 540) % 360) - 180;
      lastBearingRef.current = (prev + delta * 0.5 + 360) % 360;
    }

    // Approach ramp: 0 = cruising, 1 = at the junction. No maneuver (route
    // finished, or none resolved yet) reads as cruising — wide context is the
    // right default when there is nothing specific to lean into.
    const md = maneuverDistRef.current;
    const rampTarget =
      md == null ? 0 : Math.max(0, Math.min(1, (CAM_FAR_M - md) / (CAM_FAR_M - CAM_NEAR_M)));
    // A deliberate recenter or a nav start should land on the correct pose at
    // once; only the per-fix follow is smoothed.
    camRampRef.current = fly
      ? rampTarget
      : camRampRef.current + (rampTarget - camRampRef.current) * CAM_SMOOTH;
    const r = camRampRef.current;
    const navZoom = CRUISE_ZOOM + (NAV_ZOOM - CRUISE_ZOOM) * r;
    const navPitch = CRUISE_PITCH + (NAV_PITCH - CRUISE_PITCH) * r;

    const center: [number, number] = [loc.coords.longitude, loc.coords.latitude];
    const target =
      mode === "nav"
        ? { center, zoom: navZoom, pitch: navPitch, bearing: lastBearingRef.current }
        : { center, zoom: 15.5, pitch: 45, bearing: 0 };
    if (fly) cam.flyTo({ ...target, duration: 900 });
    else cam.easeTo({ ...target, duration: 600 }); // settles before the next ~2s ping
  }, []);

  // Keep the camera's view of "how far to the next turn" current. Held in a ref
  // and updated here rather than read from state inside driveCamera, so that
  // callback keeps a stable identity (see maneuverDistRef).
  useEffect(() => {
    const md = status.maneuver?.distanceM;
    maneuverDistRef.current = Number.isFinite(md) ? (md as number) : null;
  }, [status.maneuver]);

  // A user gesture (pan/pinch/rotate) pauses the auto-camera. The event's
  // userInteraction flag distinguishes fingers from our own animations.
  const onRegionWillChange = useCallback(
    (e: NativeSyntheticEvent<ViewStateChangeEvent>) => {
      // Keep the live zoom for the driver tap hit-test. Different MapLibre RN
      // generations expose it under different keys, so probe a few rather than
      // betting on one; anything unparseable just leaves the last good value.
      const ne = e.nativeEvent as unknown as Record<string, any> | undefined;
      const z = ne?.zoom ?? ne?.zoomLevel ?? ne?.properties?.zoom ?? ne?.properties?.zoomLevel;
      if (typeof z === "number" && Number.isFinite(z)) zoomRef.current = z;

      if (e.nativeEvent?.userInteraction && cameraModeRef.current !== "free") {
        setMode("free");
      }
    },
    [setMode]
  );

  // The Waze crosshairs: snap back to nav view (or follow, if no route yet).
  const recenter = useCallback(() => {
    setMode(phaseRef.current === "driving" ? "nav" : "follow");
    const f = fixRef.current;
    if (f) driveCamera(f, true);
  }, [setMode, driveCamera]);

  // Waze-style voice: distance-triggered cues per maneuver, not one on
  // appearance. Three stages now (VOICE_TIERS_M = 800 / 250 / 50).
  //
  // HOW A TIER IS CHOSEN: we take the TIGHTEST threshold already crossed, not
  // the loosest unspoken one. That matters when a maneuver first appears close —
  // after a reroute, or on a short block — because announcing "in 800 metres"
  // when the turn is 300m away would be a lie. Picking the tightest crossed band
  // means the cue always describes where the driver actually is, and the spoken
  // distance comes from the LIVE distanceM rather than the tier label.
  //
  // Each tier fires at most once per maneuver, so a 2s ping stream can't repeat
  // one, and GPS jitter across a threshold can't either. Only one tier speaks
  // per ping. Distance decreases monotonically on a normal approach, so tiers
  // never backfill — but if a reroute pushes the distance back out, an unspoken
  // looser tier legitimately becomes available again, which is what you want.
  //
  // Refs (not state) so the ping stream doesn't re-run other effects.
  useEffect(() => {
    const m = status.maneuver;
    if (!m || phase !== "driving") {
      spokenRef.current = { key: "", done: VOICE_TIERS_M.map(() => false), lastM: null };
      return;
    }
    const key = maneuverKey(m);
    if (key !== spokenRef.current.key) {
      spokenRef.current = { key, done: VOICE_TIERS_M.map(() => false), lastM: null };
    }
    const d = m.distanceM;
    if (!Number.isFinite(d)) return;

    let tier = -1;
    for (let i = 0; i < VOICE_TIERS_M.length; i++) if (d <= VOICE_TIERS_M[i]) tier = i;
    if (tier < 0) return; // still beyond the outermost threshold

    const isArrive = (m.type ?? "") === "arrive";
    // Arrival has nothing useful to say 800m out, and the old code announced
    // "הגעת ליעד" — you have arrived — from up to 500m away, which is simply
    // false. It now waits for the 250m tier and phrases that one as distance.
    if (isArrive && tier === 0) return;
    if (spokenRef.current.done[tier]) return;

    const isAction = tier === VOICE_TIERS_M.length - 1;
    // Too soon after the last cue for this maneuver — defer WITHOUT marking the
    // tier done, so it still fires once the driver has covered some ground. The
    // action tier is exempt: it can never be deferred out of existence.
    const lastM = spokenRef.current.lastM;
    if (!isAction && lastM != null && lastM - d < VOICE_MIN_GAP_M) return;

    spokenRef.current.done[tier] = true;
    spokenRef.current.lastM = d;
    if (isArrive) {
      speak(isAction ? "הגעת ליעד." : `${distancePhraseHe(d)}, היעד שלך.`);
    } else {
      speak(isAction ? `כעת, ${maneuverLabel(m)}.` : maneuverSpeech(m));
    }
  }, [status.maneuver, phase, speak]);

  // PREVIEW: when a fresh route arrives, frame the whole trip (fit its bounds)
  // and hand the camera to the overview. Driving is NOT entered here — GO does
  // that. Reroutes (which update `route` while already driving) don't re-fit.
  useEffect(() => {
    if (phase !== "preview" || !pendingRoute) return;
    setMode("free"); // suspend follow while the overview is shown
    const cam = cameraRef.current;
    if (cam) {
      const [w, s, e, n] = routeBounds(pendingRoute.geometry.coordinates);
      cam.fitBounds([w, s, e, n], {
        padding: { paddingTop: 120, paddingBottom: 320, paddingLeft: 60, paddingRight: 60 },
        pitch: 0,
        animationDuration: 900,
      } as any);
    }
  }, [phase, pendingRoute, setMode]);

  // GO: leave preview, dive into the 78° carpet, start driving + voice.
  const startDrive = useCallback(() => {
    setPendingRoute(null);
    setNavPhase("driving");
    setMode("nav");
    if (fixRef.current) driveCamera(fixRef.current, true); // smooth fly into pitch 78
  }, [setNavPhase, setMode, driveCamera]);

  // Cancel preview / END NAVIGATION: drop the route and return to idle/search.
  //
  // Phase 46 wires this to the dashboard's exit button as well. It was already
  // the complete teardown — route, signals, lane samples, destination, status,
  // phase, camera mode, and a fly back to the follow pose — so a separate
  // end-navigation path would have been a second thing to keep in sync, and the
  // one most likely to drift and leave a stale overlay behind.
  const cancelPreview = useCallback(() => {
    setPendingRoute(null);
    setRoute(null);
    routeRef.current = null;
    setSignals([]); // route-scoped: no route, no lights
    setLaneSamples([]);
    setDestination(null);
    setStatus({
      onRoute: null,
      distanceM: null,
      progressPct: null,
      remainingM: null,
      remainingS: null,
      route: null,
      maneuver: null,
    });
    setNavPhase("idle");
    setMode("follow");
    if (fixRef.current) driveCamera(fixRef.current, true);
  }, [setNavPhase, setMode, driveCamera]);

  const toggleVoice = useCallback(() => {
    setVoiceOn((on) => {
      const next = !on;
      voiceOnRef.current = next;
      if (!next) Speech.stop();
      return next;
    });
  }, []);

  useEffect(() => () => { Speech.stop(); }, []);

  // Profile sheet entrance: the rank badge pops (native driver: opacity +
  // scale), and the progress bar sweeps to its target width. Width can't run on
  // the native driver, so it gets its own Animated.Value — mixing drivers on a
  // SINGLE value is what RN forbids; separate values are fine.
  const badgeAnim = useRef(new Animated.Value(0)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;
  const profilePoints = profile?.points ?? 0;
  const nextTier = nextTierFor(profilePoints);
  const currentTier = tierFor(profile?.rank ?? RANK_TIERS[0].key);
  // Fraction of the way from this tier's floor to the next tier's threshold.
  const rankProgress = nextTier
    ? Math.max(
        0,
        Math.min(
          1,
          (profilePoints - currentTier.minPoints) /
            Math.max(1, nextTier.minPoints - currentTier.minPoints)
        )
      )
    : 1;

  useEffect(() => {
    if (!profileOpen) {
      badgeAnim.setValue(0);
      progressAnim.setValue(0);
      return;
    }
    const anim = Animated.parallel([
      Animated.spring(badgeAnim, {
        toValue: 1,
        friction: 6,
        tension: 70,
        useNativeDriver: true,
      }),
      Animated.timing(progressAnim, {
        toValue: rankProgress,
        duration: 700,
        delay: 120,
        useNativeDriver: false, // width interpolation
      }),
    ]);
    anim.start();
    return () => anim.stop();
  }, [profileOpen, rankProgress, badgeAnim, progressAnim]);

  // If AsyncStorage was unavailable the id is session-only, so points and
  // history won't survive a restart. Tell the driver once rather than letting
  // their stats silently reset later.
  useEffect(() => {
    if (storageWarning) setNotice("האחסון אינו זמין — הנתונים לא יישמרו");
  }, [storageWarning]);

  // notices fade on their own
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [notice]);

  // In-drive toast: fade + rise on each new notice. Only opacity/transform are
  // animated so this runs on the native driver; the `bottom` offset stays a
  // plain style value. Re-keyed on `notice`, so a second message replaces the
  // first with a fresh entrance instead of silently swapping the text.
  const toastAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!notice || phase === "idle") return;
    toastAnim.setValue(0);
    const anim = Animated.timing(toastAnim, {
      toValue: 1,
      duration: 220,
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [notice, phase, toastAnim]);

  // Proximity banner clears itself. Keyed on the object identity, so a fresh
  // alert (even for the same report) restarts the window rather than inheriting
  // the old timer. The server's own re-alert cooldown stops this from spamming.
  useEffect(() => {
    if (!proximity) return;
    const timer = setTimeout(() => setProximity(null), PROXIMITY_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [proximity]);

  // 3. GPS watcher. The cached last-known position centres the camera instantly
  // (non-blocking), and the live watch starts alongside it — never behind it.
  // Every fix that arrives is used, whatever its accuracy.
  const didCenterRef = useRef(false);
  const centerOnFirstFix = useCallback(
    (loc: Location.LocationObject) => {
      if (didCenterRef.current) return;
      didCenterRef.current = true;
      const cam = cameraRef.current;
      if (cam) {
        cam.jumpTo({ center: [loc.coords.longitude, loc.coords.latitude], zoom: 16 });
      }
    },
    []
  );

  useEffect(() => {
    let sub: Location.LocationSubscription | null = null;
    let cancelled = false;
    (async () => {
      const { status: perm } = await Location.requestForegroundPermissionsAsync();
      if (perm !== "granted") {
        setPermissionDenied(true);
        return;
      }
      setPermissionDenied(false);

      // Instant, cached, and CANNOT hang — used only to put the camera
      // somewhere sensible while the first real fix is acquired. The previous
      // code awaited getCurrentPositionAsync() here, which indoors can block
      // for tens of seconds; because the watcher was started AFTER that await,
      // the whole location system stalled behind it. This is fire-and-forget
      // and never gates the watcher below.
      Location.getLastKnownPositionAsync()
        .then((last) => {
          if (!cancelled && last) {
            fixRef.current = last;
            setFix(last);
            updateSpeed(last);
            centerOnFirstFix(last);
          }
        })
        .catch(() => {
          /* no cached fix — the watcher will deliver one */
        });

      if (cancelled) return;
      sub = await Location.watchPositionAsync(
        {
          // PHASE 54: BestForNavigation WHILE DRIVING, High otherwise.
          //
          // The original note here is still true — BestForNavigation asks the
          // chip for a sky-view lock and can deliver nothing indoors, which is
          // why High was chosen and why flipping it globally would break
          // development at a desk. But on the road it is the correct setting,
          // and ±143m fixes are exactly what it exists to avoid. Selecting on
          // phase keeps both: the desk keeps a usable fused fix, the car gets
          // the GNSS one. `phase` is in the dependency list below, so the
          // subscription is rebuilt when driving starts — once per trip.
          accuracy:
            phase === "driving"
              ? Location.Accuracy.BestForNavigation
              : Location.Accuracy.High,
          timeInterval: PING_INTERVAL_MS,
          // 0 = report on the time interval regardless of movement. This was 5
          // metres, which meant a stationary device (i.e. anyone developing at
          // a desk) never received a second callback — the map genuinely froze
          // on whatever the first fix happened to be.
          distanceInterval: 0,
        },
        (loc) => {
          // Raw accuracy is recorded for EVERY fix, accepted or not, so the
          // quality banner and the status strip keep telling the truth about
          // the signal even while the map is deliberately ignoring it.
          rawAccuracyRef.current = loc.coords.accuracy ?? null;

          if (!acceptFix(loc)) {
            // Rejected: do not move the map, do not re-measure speed, and above
            // all do not sendPing. The ping is what the server matches against
            // the route, so feeding it a ±143m fix is what produces the
            // off-route verdict and the reroute loop the field report
            // described. Dropping it here stops that at the source.
            return;
          }

          fixRef.current = loc;
          setFix(loc);
          updateSpeed(loc);
          centerOnFirstFix(loc); // no-op after the first call
          sendPing(loc);
          driveCamera(loc);
        }
      );
    })();
    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [sendPing, driveCamera, centerOnFirstFix, updateSpeed, acceptFix, phase]);

  // ---------- GPS quality (Waze-style "approximate location") ----------
  // Hidden by default. Only shows when the signal is genuinely bad: no fresh
  // fix for well over the expected interval, OR accuracy far worse than normal
  // urban GPS. nowTick (2s heartbeat) keeps this re-evaluating; Date.now() does
  // the actual math so a fix is never falsely flagged stale between ticks.
  void nowTick; // referenced so staleness re-checks on the heartbeat
  const fixAgeMs = fix ? Date.now() - fix.timestamp : Infinity;
  // Phase 54: the RAW figure. `fix` is now the last ACCEPTED fix, so reading
  // its accuracy would report the last good signal and hide the bad one — the
  // banner would go quiet exactly when it should be speaking up.
  const accuracyM = rawAccuracyRef.current ?? fix?.coords.accuracy ?? null;
  const gpsPoor =
    !!fix &&
    !permissionDenied &&
    (fixAgeMs > STALE_FIX_MS || (accuracyM != null && accuracyM > POOR_ACCURACY_M));

  // ---------- HUD state ----------
  const hud = permissionDenied
    ? { dot: C.slate, label: "LOCATION PERMISSION DENIED", detail: "enable location to start tracking" }
    : !connected
    ? {
        dot: C.slate,
        label: "CONNECTING…",
        detail: isUsingLocalhostFallback(SERVER_PORT)
          ? `server ${serverHost} — localhost won't reach your PC; tap to set its LAN IP`
          : `server ${serverHost} — tap to change`,
      }
    : status.onRoute === null
    ? {
        dot: C.amber,
        label: "WAITING FOR ROUTE FIX",
        detail: fix ? "no status yet — route seeded on the server?" : "acquiring GPS…",
      }
    : status.onRoute
    ? {
        dot: C.green,
        label: status.route === "dynamic" ? "ON ROUTE" : "ON ROUTE 90",
        detail: `${status.distanceM} m from centerline · ${status.progressPct}% along route`,
      }
    : {
        dot: C.red,
        label: "OFF ROUTE",
        detail: `${status.distanceM} m from ${status.route === "dynamic" ? "your route" : "Route 90"}`,
      };

  const accM =
    rawAccuracyRef.current != null
      ? rawAccuracyRef.current.toFixed(0)
      : fix?.coords.accuracy != null
        ? fix.coords.accuracy.toFixed(0)
        : "–";

  return (
    <View style={styles.container}>
      <MapLibreMap
        ref={mapRef}
        style={styles.map}
        // Transformed style object when the interceptor succeeded; the raw URL
        // otherwise, so a failed fetch degrades to the stock basemap rather
        // than a blank screen.
        mapStyle={styleJson ?? (isDarkMode ? MAP_STYLE_DARK : MAP_STYLE_LIGHT)}
        onPress={handleMapPress}
        onLongPress={handleLongPress}
        onRegionWillChange={onRegionWillChange}
      >
        <Camera ref={cameraRef} initialViewState={{ center: TIBERIAS_CENTER, zoom: 13, pitch: 45 }} />

        {/* Phase 31: LANE-LEVEL CARRIAGEWAY.
            Drawn UNDER the route ribbon, so the ribbon reads as guidance
            painted onto a real road surface — the Amap/Baidu structure —
            rather than a line floating over a map. Lane detail only resolves
            above ~z16.5: below that a 3.6m offset is sub-pixel and the lines
            would smear together, so they fade out instead of turning to mush. */}
        {lanes && (
          <>
            {/* asphalt */}
            <GeoJSONSource id="lane-surface" data={lanes.asphalt}>
              <Layer
                id="lane-asphalt"
                type="line"
                beforeId="route90-glow"
                layout={{ "line-cap": "round", "line-join": "round" }}
                paint={{
                  // PHASE 42, contrast-matched. The Gaode night capture runs its
                  // lit carriageway at #60687C against #324A57 terrain — a 1.67:1
                  // luminance ratio. Ours was #12161F over a #070B14 basemap:
                  // 1.08:1, which is barely a road at all, so adjacent lanes sank
                  // into the background. #2F3951 @0.95 composites to #2D374E and
                  // restores 1.66:1 against our (much darker) background.
                  "line-color": isDarkMode ? "#2F3951" : "#3A4048",
                  // Width is DATA-DRIVEN from each span's real lane count, so a
                  // residential street renders narrow and a motorway wide. The
                  // exponential base-2 zoom curve matches how metres-per-pixel
                  // halves per zoom level, keeping the band at a true
                  // real-world width rather than a fixed pixel size.
                  "line-width": [
                    "interpolate",
                    ["exponential", 2],
                    ["zoom"],
                    15, ["*", ["get", "laneCount"], 0.9],
                    20, ["*", ["get", "laneCount"], 28.8],
                  ],
                  "line-opacity": ["interpolate", ["linear"], ["zoom"], 15.5, 0, 16.5, 0.95],
                }}
              />
            </GeoJSONSource>

            {/* solid outer edge lines */}
            <GeoJSONSource id="lane-edges" data={lanes.edges}>
              <Layer
                id="lane-edge-lines"
                type="line"
                beforeId="route90-glow"
                layout={{ "line-cap": "round", "line-join": "round" }}
                paint={{
                  "line-color": "#E8EEF7",
                  "line-width": ["interpolate", ["linear"], ["zoom"], 16, 0.8, 18, 2.4, 20, 6],
                  "line-opacity": ["interpolate", ["linear"], ["zoom"], 16.5, 0, 17.5, 0.85],
                }}
              />
            </GeoJSONSource>

            {/* Dashed interior dividers. A single-lane span produces NONE, so
                a residential street correctly shows no centre dashes — the
                exact inaccuracy the fixed 2-lane version created. */}
            <GeoJSONSource id="lane-dividers" data={lanes.dividers}>
              <Layer
                id="lane-divider-lines"
                type="line"
                // PHASE 53: lifted ABOVE the route stack. As beforeId
                // route90-glow these sat under a 22px glow + 15px casing on the
                // centreline, which buried the innermost dividers exactly where
                // the driver looks. The corridor cannot cover them — it is
                // inset 0.65m per side and its glow clamps to that, leaving
                // 0.4m of clearance to the lane boundary — so above the ribbon
                // is above everything that was actually hiding them.
                afterId="route90-arrows"
                layout={{ "line-cap": "butt", "line-join": "round" }}
                paint={{
                  "line-color": "#FFFFFF",
                  // Crisper and a touch heavier: the Baidu reference reads as
                  // bright, unmistakable dashes, not hairlines.
                  "line-width": ["interpolate", ["linear"], ["zoom"], 16, 0.8, 18, 2.6, 20, 6],
                  // Phase 42: a divider drawn off LANE_COUNT_FALLBACK rather than
                  // OSM data renders at ~55% strength. The lane count still has to
                  // match the guidance laid over it, but an inferred divider
                  // shouldn't assert itself as hard as a surveyed one.
                  // MapLibre requires ["zoom"] to feed a TOP-LEVEL step or
                  // interpolate — nesting the zoom ramp inside ["*"] made
                  // native reject the whole property (the JNI error). The
                  // per-feature factor moves into the ramp's top stop, which
                  // is algebraically identical: 0.7*1 and 0.7*0.55.
                  "line-opacity": [
                    "interpolate",
                    ["linear"],
                    ["zoom"],
                    16.5, 0,
                    17.5, ["case", ["==", ["get", "known"], 1], 0.95, 0.6],
                  ],
                  // Dashes are measured in LINE-WIDTHS, so the pattern keeps
                  // its proportions as the width interpolates with zoom.
                  // Phase 53: 2:2 reads as a standard broken lane line; the old
                  // 2.5:3.5 left long gaps that dissolved at speed.
                  "line-dasharray": [2, 2],
                }}
              />
            </GeoJSONSource>
          </>
        )}

        {/* Phase 35: lane turn arrows painted on the asphalt. Fill polygons —
            true ground geometry — pinned above the route ribbon so guidance
            paint reads over the carpet, and (mounting after the earlier-
            pinned signal layers at the same anchor) beneath the lights. The
            lane the driver should take glows near-white; the rest stay dim,
            mirroring the HUD's valid/invalid treatment. Fades in with the
            carriageway: below ~z16.5 a 3.6m lane is sub-pixel. */}
        {laneArrows && (
          <GeoJSONSource id="lane-arrows" data={laneArrows}>
            <Layer
              id="lane-arrow-marks"
              type="fill"
              afterId="route90-arrows"
              paint={{
                "fill-color": ["case", ["==", ["get", "valid"], 1], "#F2FFFF", "#C7D3E6"],
                // Phase 42: the INACTIVE figure was raised 0.42 -> 0.68. In the
                // night reference, markings on non-route lanes sit at #E6E9ED
                // against #60687C asphalt — a 4.58:1 ratio, clearly readable.
                // 0.42 over our new asphalt gave only 2.71:1, so adjacent lanes
                // were losing their arrows. 0.68 restores 4.56:1. The active lane
                // is untouched at 0.95 and still reads 10.65:1, so the valid /
                // invalid distinction survives — both are visible, one dominates.
                "fill-opacity": [
                  "interpolate",
                  ["linear"],
                  ["zoom"],
                  16.4, 0,
                  17.2, ["case", ["==", ["get", "valid"], 1], 0.95, 0.68],
                ],
              }}
            />
          </GeoJSONSource>
        )}

        {/* Phase 39: HIGHLIGHTED LANE CORRIDOR — the glowing ribbon over the
            lane(s) that serve the next maneuver.

            Z-ORDER. This block sits AFTER the lane-arrow block on purpose.
            MapLibre stacks by native add order, and `afterId` inserts
            ADJACENTLY above its anchor — so of several layers pinned to the
            same anchor, the one added LAST ends up LOWEST. Both stacks pin to
            "route90-arrows", and the corridor's mount condition is a strict
            subset of the arrows' (it additionally needs a partial valid set),
            so the corridor can never be added first. Result, bottom to top:

              lane-asphalt / edges / dividers   (beforeId route90-glow)
              route90-glow ... route90-arrows   (the route ribbon)
              lane-corridor-glow                <- emission
              lane-corridor-core                <- the ribbon itself
              lane-corridor-rim                 <- brighter edge each side
              lane-corridor-chevrons            <- white marks inside it
              lane-arrow-marks                  (arrows read over the ribbon)
              signals-*                         (mount in preview -> stay top)

            which is exactly "on the asphalt, under the arrows, under the
            lights". The corridor is pinned above the route ribbon rather than
            down with the carriageway because the ribbon is opaque: painted
            underneath it, the highlight would be invisible for most of its run.

            The gate is `laneArrows && laneCorridor`, not `laneCorridor` alone,
            so the two stacks mount and unmount as a unit and their relative
            order can never invert. Without it there's a window — slice shorter
            than the 25m arrow row, so the arrows drop while the corridor stays
            — where a later-mounting arrow layer would insert BENEATH the
            ribbon. The cost is that the corridor also disappears inside 25m,
            which is the behaviour the arrows already have: at that range the
            lane is chosen and the guidance has done its job.

            COLOUR (Phase 40) is measured, not chosen. The Gaode NIGHT capture
            renders its corridor at #3BA58B over #2F3C4F asphalt. Ours is
            darker (#12161F), so copying that fill verbatim would come out
            muddy; the fill and alpha were solved backwards instead, so the
            COMPOSITE lands on the reference: #17E8A8 @0.18 then #4CD4B0 @0.70
            gives #3BA68C, 2/255 total error. Still deliberately not C.green
            (#22C55E) — that's the signal-green on screen at the same junction.

            Two geometries rather than a blur: fill layers have no fill-blur
            (only line-blur, which the route stack uses), so the emission is the
            same ribbon built 1.1m wider each side, underneath at low opacity.

            Opacity is a product of a zoom fade — below ~z16.5 a 3.6m lane is
            sub-pixel, same threshold as the carriageway — and a ramp on `t`.
            The ramp softens ONLY the tail nearest the camera: the references
            hold full strength right up to the junction, which is where the
            driver is actually looking, so fading that end (as Phase 39 did)
            was backwards. */}
        {laneArrows && laneCorridor && (
          <>
            {/* 1. emission — widened ribbon, low opacity, breathing */}
            <GeoJSONSource id="lane-corridor-glow-src" data={laneCorridor.glow}>
              <Layer
                id="lane-corridor-glow"
                type="fill"
                afterId="route90-arrows"
                paint={{
                  "fill-color": C.laneCorridorGlow,
                  // Zoom ramp hoisted to top level (see lane-divider-lines):
                  // the along-corridor fade becomes the ramp's top stop, a
                  // standard zoom+property composite MapLibre accepts.
                  "fill-opacity": [
                    "interpolate",
                    ["linear"],
                    ["zoom"],
                    16.4, 0,
                    17.2, [
                      "interpolate",
                      ["linear"],
                      ["get", "t"],
                      0, 0.05,
                      0.10, 0.18 + pulseWave * 0.05,
                      1, 0.18 + pulseWave * 0.05,
                    ],
                  ],
                }}
              />
            </GeoJSONSource>

            {/* 2. core ribbon. #4CD4B0 @ 0.70 over #12161F asphalt composites
                to #3BA68C — the colour sampled off the Gaode night capture. */}
            <GeoJSONSource id="lane-corridor-core-src" data={laneCorridor.core}>
              <Layer
                id="lane-corridor-core"
                type="fill"
                afterId="lane-corridor-glow"
                paint={{
                  "fill-color": C.laneCorridor,
                  "fill-opacity": [
                    "interpolate",
                    ["linear"],
                    ["zoom"],
                    16.4, 0,
                    17.2, [
                      "interpolate",
                      ["linear"],
                      ["get", "t"],
                      0, 0.18,
                      0.10, 0.70,
                      1, 0.70,
                    ],
                  ],
                }}
              />
            </GeoJSONSource>

            {/* 3. edge lines. Every reference runs a brighter rim down both
                sides of the ribbon. Pixel-width stroke, like lane-edge-lines. */}
            <GeoJSONSource id="lane-corridor-rim-src" data={laneCorridor.rim}>
              <Layer
                id="lane-corridor-rim"
                type="line"
                afterId="lane-corridor-core"
                layout={{ "line-cap": "round", "line-join": "round" }}
                paint={{
                  "line-color": C.laneCorridorRim,
                  "line-width": ["interpolate", ["linear"], ["zoom"], 16.5, 0.6, 18, 1.8, 20, 4],
                  "line-opacity": ["interpolate", ["linear"], ["zoom"], 16.4, 0, 17.2, 0.55],
                }}
              />
            </GeoJSONSource>

            {/* 4. chevrons. The signature element, present in all four
                references and previously missing: repeating white marks
                INSIDE the ribbon, every 8m, ~2.3m wide. Colour #EBEEFF is
                sampled straight off the reference chevrons. Sits above the
                ribbon but still below lane-arrow-marks. */}
            <GeoJSONSource id="lane-corridor-chevrons-src" data={laneCorridor.chevrons}>
              <Layer
                id="lane-corridor-chevrons"
                type="fill"
                afterId="lane-corridor-rim"
                paint={{
                  "fill-color": C.laneChevron,
                  "fill-opacity": [
                    "interpolate",
                    ["linear"],
                    ["zoom"],
                    16.8, 0,
                    17.6, [
                      "interpolate",
                      ["linear"],
                      ["get", "t"],
                      0, 0.20,
                      0.12, 0.85,
                      1, 0.85,
                    ],
                  ],
                }}
              />
            </GeoJSONSource>
          </>
        )}

        {route && (
          <GeoJSONSource id="route90" data={route} lineMetrics>
            {/* PHASE 50: the ribbon no longer collapses to a hairline as the
                corridor lights up. Every coloured band below is a
                line-gradient with a transparent hole across exactly the span
                the corridor covers (see lib/routeGradient.ts), so widths and
                opacities stay at FULL strength — the route beyond the junction
                is drawn exactly as it always was, while the stretch the green
                corridor owns is simply not painted blue at all. The hole's
                alpha rides the same routeYield ramp, so it fades in with
                distance instead of snapping on at one GPS tick. */}
            {/* 1. wide soft outer glow */}
            <Layer
              id="route90-glow"
              type="line"
              layout={{ "line-cap": "round", "line-join": "round" }}
              paint={{
                "line-gradient": holedSolid(C.routeGlow),
                "line-width": 22,
                "line-opacity": ribbonFullyHidden ? 0 : 0.3,
                "line-blur": 10,
              }}
            />
            {/* 2. dark casing for contrast */}
            <Layer
              id="route90-casing"
              type="line"
              layout={{ "line-cap": "round", "line-join": "round" }}
              paint={{
                "line-gradient": holedSolid("#062B63"),
                "line-width": 15,
                "line-opacity": ribbonFullyHidden ? 0 : 1,
              }}
            />
            {/* 3. the driving "carpet": green near the car -> cyan ahead.
                 line-gradient needs lineMetrics on the source (set above).
                 Under the 60° nav pitch, this wide band already narrows toward
                 the horizon, giving the perspective-lane look.

                 This is the widest coloured band and so the main offender when
                 the corridor is lit; line-opacity multiplies the gradient's
                 own alpha, so it dims without disturbing the colour ramp. */}
            <Layer
              id="route90-line"
              type="line"
              layout={{ "line-cap": "round", "line-join": "round" }}
              paint={{
                "line-width": 11,
                "line-opacity": ribbonFullyHidden ? 0 : 1,
                // the green->cyan->blue ramp, with the corridor span cut out
                "line-gradient": asPaintExpr(gradientWithHole(ROUTE_RAMP, ribbonHole)),
              }}
            />
            {/* 4. bright inner core — glossy sheen down the middle, and the
                 one element that SURVIVES deference as the micro-line. */}
            <Layer
              id="route90-core"
              type="line"
              layout={{
                "line-cap": "round",
                "line-join": "round",
              }}
              paint={{
                "line-gradient": holedSolid("#EAFFFF"),
                "line-width": 2.5,
                "line-opacity": ribbonFullyHidden ? 0 : 0.85,
              }}
            />
            {/* 5. directional chevrons flowing along the asphalt */}
            <Layer
              id="route90-arrows"
              type="symbol"
              layout={{
                "symbol-placement": "line",
                "symbol-spacing": 80,
                // "»" lives in glyph range 0-255 (always served); the font
                // must be named explicitly. Both basemaps serve this stack:
                // OpenFreeMap serves only Noto Sans (Phase 2 field finding),
                // and CARTO's dark-matter lists "Noto Sans Regular" inside
                // its own layer fontstacks (verified from the live style
                // JSON), so the chevrons survive the day/night swap.
                "text-field": "»",
                "text-font": ["Noto Sans Regular"],
                "text-rotation-alignment": "map",
                // lies FLAT on the road instead of billboarding at the camera —
                // this is what makes the chevrons read as painted markings
                "text-pitch-alignment": "map",
                "text-keep-upright": false,
                "text-size": 18,
                "text-allow-overlap": true,
                "text-ignore-placement": true,
              }}
              paint={{
                "text-color": "#FFFFFF",
                "text-halo-color": "#043B2A",
                "text-halo-width": 1.4,
                // Faded rather than unmounted, and that is load-bearing: SIX
                // other layers use afterId="route90-arrows" as their z-anchor
                // (the corridor stack, maneuver beam, turn point, 3D beacon and
                // the signals). Unmounting this layer would strand every one of
                // them. text-opacity 0 keeps the anchor alive while the marks
                // disappear — which they should, since the corridor paints its
                // own chevrons over the same asphalt and two sets flowing at
                // different spacings is exactly the clutter we are removing.
                // PHASE 52: explicitly binary, not a ramp. The corridor paints
                // its own chevrons inside the ribbon, so route chevrons over
                // the same stretch are pure clutter — the field report called
                // them out twice. They vanish the moment the corridor exists
                // rather than fading out over the last 150m.
                "text-opacity": laneCorridor ? 0 : 1,
              }}
            />
          </GeoJSONSource>
        )}

        {/* Phase 24: nearby drivers. Four stacked layers off ONE source —
            all GPU-drawn, all data-driven from the feature properties. */}
        {nearbyCount > 0 && (
          <GeoJSONSource id="nearby-drivers" data={nearbyGeoJson}>
            {/* 1. soft halo, so a car reads against both light and dark basemaps */}
            <Layer
              id="drivers-halo"
              type="circle"
              paint={{
                "circle-radius": 17,
                "circle-color": ["get", "rankColor"],
                "circle-opacity": 0.18,
                "circle-blur": 0.5,
              }}
            />
            {/* 2. body — rank-coloured disc with a white ring */}
            <Layer
              id="drivers-body"
              type="circle"
              paint={{
                "circle-radius": 11,
                "circle-color": ["get", "rankColor"],
                "circle-stroke-color": "#FFFFFF",
                "circle-stroke-width": 2.5,
              }}
            />
            {/* 3. direction chevron, rotated to the driver's course. Uses the
                   SAME "»" glyph + explicit Noto Sans fontstack as the route
                   arrows — proven to render on both basemaps (glyph range
                   0-255). text-rotate is data-driven from `heading`;
                   rotation-alignment "map" keeps it true as the map rotates
                   under the 78° nav camera. Drivers with no GPS course get
                   opacity 0 here and stay a plain dot. */}
            <Layer
              id="drivers-heading"
              type="symbol"
              layout={{
                "text-field": "»",
                "text-font": ["Noto Sans Regular"],
                "text-size": 15,
                "text-rotate": ["get", "heading"],
                "text-rotation-alignment": "map",
                "text-keep-upright": false,
                "text-allow-overlap": true,
                "text-ignore-placement": true,
              }}
              paint={{
                "text-color": "#FFFFFF",
                "text-opacity": ["get", "hasHeading"],
              }}
            />
            {/* 4. rank badge above each car. ASCII initial (N/K/M) for glyph
                   safety; allow-overlap false so a dense cluster declutters
                   itself instead of turning into mush. */}
            <Layer
              id="drivers-rank"
              type="symbol"
              layout={{
                "text-field": ["get", "rankInitial"],
                "text-font": ["Noto Sans Regular"],
                "text-size": 11,
                "text-offset": [0, -1.7],
                "text-allow-overlap": false,
                "text-optional": true,
              }}
              paint={{
                "text-color": ["get", "rankColor"],
                "text-halo-color": "#FFFFFF",
                "text-halo-width": 1.6,
              }}
            />
          </GeoJSONSource>
        )}

        {/* Phase 34: crowd report pins. Every active report (live or replayed)
            is a tappable pin — tap opens the "עדיין שם?" vote popup. GPU
            layers off one source, same pattern as the drivers; the colour is
            the report type's colour from REPORT_OPTIONS, so the map and the
            report menu speak one visual language. The "!" mark is ASCII on
            purpose — the same glyph-range constraint as the route chevrons. */}
        {reportPinCount > 0 && (
          <GeoJSONSource id="reports" data={reportsGeoJson}>
            <Layer
              id="reports-halo"
              type="circle"
              paint={{
                "circle-radius": 16,
                "circle-color": ["get", "color"],
                "circle-opacity": 0.2,
                "circle-blur": 0.5,
              }}
            />
            <Layer
              id="reports-pin"
              type="circle"
              paint={{
                "circle-radius": 10,
                "circle-color": ["get", "color"],
                "circle-stroke-color": "#FFFFFF",
                "circle-stroke-width": 2.5,
              }}
            />
            <Layer
              id="reports-mark"
              type="symbol"
              layout={{
                "text-field": "!",
                "text-font": ["Noto Sans Regular"],
                "text-size": 13,
                "text-allow-overlap": true,
                "text-ignore-placement": true,
              }}
              paint={{ "text-color": "#FFFFFF" }}
            />
          </GeoJSONSource>
        )}

        {/* Phase 28: MANEUVER BEAM — the stretch of road between the driver
            and the next turn, overlaid on the route in hot white-cyan with
            large fast chevrons. This is the "which way am I going" cue: the
            normal route ribbon stays cool blue-green, and only the part you're
            about to act on lights up.
            Phase 34: pinned just above the route stack (afterId), so this
            late-mounting glow can no longer bury the traffic-light icons. */}
        {/* Phase 51: the beam rides drivingSlice, not the raw centreline. It is
            a 26px cyan glow, so leaving it on a two-way road's centre line
            while the corridor moved onto our carriageway would simply have
            re-created the reported bug in a different colour.

            PHASE 53 — and it is now hidden outright once the corridor exists.
            THIS was the "blue chevrons" in the field reports, not
            route90-arrows: maneuver-beam-arrows is a symbol layer drawing "»"
            at 0.75-1.0 opacity with no yield term at all, so it was never
            affected by any of the route-ribbon work. Worse, Phase 51 moved the
            beam onto drivingSlice — the SAME line the corridor uses — which
            planted those chevrons precisely on top of the green ribbon, right
            where they'd fight its own white chevrons. The beam and the
            corridor are two answers to one question; once the corridor is up
            it is strictly the better one, so the beam stands down entirely. */}
        {!laneCorridor && drivingSlice && drivingSlice.length >= 2 && (
          <GeoJSONSource
            id="maneuver-beam"
            data={{
              type: "Feature",
              properties: {},
              geometry: { type: "LineString", coordinates: drivingSlice },
            }}
          >
            <Layer
              id="maneuver-beam-glow"
              type="line"
              afterId="route90-arrows"
              layout={{ "line-cap": "round", "line-join": "round" }}
              paint={{
                "line-color": "#7DF9FF",
                "line-width": 26,
                // breathes with the ticker so the beam reads as live
                "line-opacity": 0.18 + pulseWave * 0.22,
                "line-blur": 12,
              }}
            />
            <Layer
              id="maneuver-beam-core"
              type="line"
              afterId="maneuver-beam-glow"
              layout={{ "line-cap": "round", "line-join": "round" }}
              paint={{ "line-color": "#EAFFFF", "line-width": 4, "line-opacity": 0.9 }}
            />
            {/* Dense, oversized chevrons — the "futuristic arrows". Same
                proven "»" glyph + explicit Noto Sans stack as the route
                arrows, so it renders on both basemaps. */}
            <Layer
              id="maneuver-beam-arrows"
              type="symbol"
              afterId="maneuver-beam-core"
              layout={{
                "symbol-placement": "line",
                "symbol-spacing": 42,
                "text-field": "»",
                "text-font": ["Noto Sans Regular"],
                "text-rotation-alignment": "map",
                "text-pitch-alignment": "map", // painted on the asphalt
                "text-keep-upright": false,
                "text-size": 30,
                "text-allow-overlap": true,
                "text-ignore-placement": true,
              }}
              paint={{
                "text-color": "#FFFFFF",
                "text-halo-color": "#00AEEF",
                "text-halo-width": 2.2,
                "text-opacity": 0.75 + pulseWave * 0.25,
              }}
            />
          </GeoJSONSource>
        )}

        {/* Phase 28: TURN POINT — a pulsing target ring exactly where the next
            maneuver happens, with the turn's own direction glyph on top. */}
        {maneuverVisual && (
          <GeoJSONSource
            id="maneuver-point"
            data={{
              type: "Feature",
              properties: {},
              geometry: { type: "Point", coordinates: maneuverVisual.point },
            }}
          >
            <Layer
              id="maneuver-point-pulse"
              type="circle"
              afterId="route90-arrows"
              paint={{
                "circle-radius": 20 + pulseWave * 14,
                "circle-color": "#00E5FF",
                "circle-opacity": 0.3 - pulseWave * 0.18,
              }}
            />
            <Layer
              id="maneuver-point-ring"
              type="circle"
              afterId="maneuver-point-pulse"
              paint={{
                "circle-radius": 15,
                "circle-color": "rgba(4,26,48,0.9)",
                "circle-stroke-color": "#00E5FF",
                "circle-stroke-width": 3,
              }}
            />
            <Layer
              id="maneuver-point-glyph"
              type="symbol"
              afterId="maneuver-point-ring"
              layout={{
                "text-field": maneuverArrowGlyph(status.maneuver),
                "text-font": ["Noto Sans Regular"],
                "text-size": 18,
                "text-allow-overlap": true,
                "text-ignore-placement": true,
              }}
              paint={{ "text-color": "#EAFFFF" }}
            />
          </GeoJSONSource>
        )}

        {/* Phase 31: 3D TURN BEACON.
            fill-extrusion is the only primitive that genuinely occupies HEIGHT
            in the scene — a symbol either faces the camera or lies flat, but an
            extruded polygon is a real object, correctly occluded by the 3D
            buildings around it. At 80° pitch this reads as a marker standing on
            the road ahead, which is the effect the reference images are built
            around. Rendered before the flat overlays so those paint on top. */}
        {beacon && (
          <>
            <GeoJSONSource id="beacon-pillar" data={beacon.pillar}>
              <Layer
                id="beacon-pillar-3d"
                type="fill-extrusion"
                afterId="route90-arrows"
                paint={{
                  "fill-extrusion-color": "#00E5FF",
                  // breathes with the ticker so it pulses like a live marker
                  "fill-extrusion-height": 10 + pulseWave * 7,
                  "fill-extrusion-base": 0,
                  "fill-extrusion-opacity": 0.32 + pulseWave * 0.12,
                  "fill-extrusion-vertical-gradient": true,
                }}
              />
            </GeoJSONSource>
            {/* gantry slab spanning the carriageway, like an overhead sign
                gantry — reinforces that the turn is AT this point on the road */}
            <GeoJSONSource id="beacon-gantry" data={beacon.gantry}>
              <Layer
                id="beacon-gantry-3d"
                type="fill-extrusion"
                afterId="beacon-pillar-3d"
                paint={{
                  "fill-extrusion-color": "#EAFFFF",
                  "fill-extrusion-height": 7.5,
                  "fill-extrusion-base": 6.2,
                  "fill-extrusion-opacity": 0.55 + pulseWave * 0.25,
                }}
              />
            </GeoJSONSource>
          </>
        )}

        {/* Phase 28/29/34: TRAFFIC SIGNALS along the route.
            Drawn as an actual three-lamp traffic light, not a coloured dot —
            the previous version read as "random circles" on the road.

            Phase 34 Z-ORDER: MapLibre stacks layers by NATIVE ADD ORDER, not
            JSX order. The maneuver beam, turn point, 3D beacon and lane
            carriageway all mount MID-DRIVE — later than these lights — so
            they used to land on top and bury the icons at exactly the
            junction the driver is looking at. Every signal layer is now
            pinned with afterId above the route stack, and the mid-drive
            decorations are pinned to the same anchor (see their afterId
            props), so the lights stay visible whatever mounts when. Signals
            mount earliest (they arrive during preview), so under adjacent-
            insert semantics they finish above the driving-phase decorations
            as well. Server-side, stop-line nodes are clustered (~30m) into
            one icon per junction, and inferred lights arrive flagged so they
            render dimmer here and label themselves "משוער" in the countdown.

            Built entirely from circle layers using `circle-translate`, which
            offsets in SCREEN PIXELS rather than map units: the lamps therefore
            hold their positions inside the housing at every zoom and pitch.
            No icon images and no font glyphs are involved, so this renders
            identically on both basemaps — unlike an emoji or an arrow
            character, which would need glyph ranges neither provider serves
            reliably. The lit lamp is full-strength; the other two are dimmed
            like a real head. */}
        {signals.length > 0 && (
          <GeoJSONSource id="route-signals" data={signalsGeoJson}>
            {/* outer glow in the current phase colour — visible at a glance */}
            <Layer
              id="signals-glow"
              type="circle"
              afterId="route90-arrows"
              paint={{
                "circle-radius": 17,
                "circle-color": ["case", ["==", ["get", "green"], 1], "#22C55E", "#EF4444"],
                "circle-opacity": ["case", ["==", ["get", "inferred"], 1], 0.12, 0.22],
                "circle-blur": 0.6,
              }}
            />
            {/* housing */}
            <Layer
              id="signals-housing"
              type="circle"
              afterId="signals-glow"
              paint={{
                "circle-radius": 11,
                "circle-color": "#0B1220",
                "circle-stroke-color": ["case", ["==", ["get", "inferred"], 1], "#8FA3BF", "#E8EDF5"],
                "circle-stroke-width": 2,
              }}
            />
            {/* red lamp — top */}
            <Layer
              id="signals-lamp-red"
              type="circle"
              afterId="signals-housing"
              paint={{
                "circle-radius": 2.9,
                "circle-translate": [0, -5.6],
                "circle-color": "#EF4444",
                "circle-opacity": ["case", ["==", ["get", "green"], 1], 0.22, 1],
              }}
            />
            {/* amber lamp — middle, always dim (we only model red/green) */}
            <Layer
              id="signals-lamp-amber"
              type="circle"
              afterId="signals-lamp-red"
              paint={{
                "circle-radius": 2.9,
                "circle-translate": [0, 0],
                "circle-color": "#F59E0B",
                "circle-opacity": 0.22,
              }}
            />
            {/* green lamp — bottom */}
            <Layer
              id="signals-lamp-green"
              type="circle"
              afterId="signals-lamp-amber"
              paint={{
                "circle-radius": 2.9,
                "circle-translate": [0, 5.6],
                "circle-color": "#22C55E",
                "circle-opacity": ["case", ["==", ["get", "green"], 1], 1, 0.22],
              }}
            />
          </GeoJSONSource>
        )}

        {destination && (
          <GeoJSONSource
            id="destination"
            data={{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: destination } }}
          >
            <Layer
              id="destination-pin"
              type="circle"
              paint={{
                "circle-radius": 8,
                "circle-color": C.route,
                "circle-stroke-color": "#FFFFFF",
                "circle-stroke-width": 2.5,
              }}
            />
          </GeoJSONSource>
        )}

        {/* native puck: "course" renders a navigation arrow from GPS heading —
            and no accuracy halo (that circle was the JS puck's accuracy prop) */}
        <NativeUserLocation mode="course" androidPreferredFramesPerSecond={30} />
      </MapLibreMap>

      {/* Phase 31: ATMOSPHERIC HORIZON.
          At 80° pitch the far end of the view compresses into a hard band of
          detail at the top of the map, which looks flat and busy. Real 3D nav
          apps fade that into haze so distance reads as depth.

          Implemented as stacked React Native views rather than a MapLibre `sky`
          layer: sky support varies by native SDK generation, and an unsupported
          root key or layer type risks failing the whole style parse — which
          would cost the entire map for a cosmetic gain. This is free, safe, and
          renders identically everywhere. pointerEvents none so it never eats a
          map gesture. */}
      {phase === "driving" && (
        <View style={styles.horizonHaze} pointerEvents="none">
          <View style={[styles.hazeBand, { opacity: 0.55 }]} />
          <View style={[styles.hazeBand, { opacity: 0.35 }]} />
          <View style={[styles.hazeBand, { opacity: 0.18 }]} />
          <View style={[styles.hazeBand, { opacity: 0.08 }]} />
        </View>
      )}

      {/* GPS-poor: thin top strip instead of the full-screen border */}
      {status.onRoute === false && !gpsPoor && (
        <View style={[styles.topStrip, { backgroundColor: C.red }]} pointerEvents="none" />
      )}

      {/* Waze-style GPS warning — a satellite issue, not an app bug. Yields to
          the hazard banner, which occupies the same strip and outranks it. */}
      {gpsPoor && !proximity && (
        <View style={styles.gpsBanner} pointerEvents="none">
          <Ionicons name="warning" size={16} color={C.amber} />
          <Text style={styles.gpsText}>אין קליטת GPS — מציג מיקום משוער</Text>
        </View>
      )}

      {/* Phase 21 (V2X): hazard-ahead warning. Deliberately the loudest thing on
          screen and the highest z-index — it renders in EVERY phase, because the
          server scans on telemetry whether or not a route is active. Tap to
          dismiss; otherwise it clears itself after PROXIMITY_VISIBLE_MS. */}
      {proximity && (
        <Pressable
          style={[styles.proximityBanner, { top: insets.top + 10 }]}
          onPress={() => setProximity(null)}
        >
          <View style={styles.proximityIconWrap}>
            <Ionicons
              name={
                REPORT_OPTIONS.find((o) => o.type === proximity.reportType)?.icon ?? "warning"
              }
              size={30}
              color="#FFFFFF"
            />
          </View>
          <View style={styles.proximityTextCol}>
            <Text style={styles.proximityTitle} numberOfLines={1}>
              {REPORT_OPTIONS.find((o) => o.type === proximity.reportType)?.label ??
                proximity.reportType}{" "}
              לפניך
            </Text>
            <Text style={styles.proximityDist}>
              {Math.max(0, Math.round(proximity.distanceM))} מ׳
            </Text>
          </View>
          <Ionicons name="close" size={20} color="rgba(255,255,255,0.85)" />
        </Pressable>
      )}

      {/* top: maneuver card while driving (idle search now lives in the bottom sheet).
          Pushed down while a proximity warning is up so the two never collide. */}
      {phase === "driving" && (
      <View
        style={[styles.topStack, { top: topStackTop }]}
        pointerEvents="box-none"
      >
        {/* active navigation: premium turn-by-turn card, with off-route folded in */}
        {/* PHASE 48: the group owns the rounded shell, the border and the
            shadow; the banner and the lane box inside it are square-cornered and
            flat, separated only by a hairline. overflow:"hidden" is what clips
            them to the group's radius, so the two read as one physical object
            rather than two cards that happen to be adjacent. */}
        {/* Phase 50: the signal countdown card positions itself from this
            group's MEASURED height, so it can't slide under the banner when
            the banner wraps or the lane box appears. */}
        <View style={styles.guidanceGroup} onLayout={onGuidanceGroupLayout}>
        <Pressable style={styles.maneuverBanner} onPress={recenter}>
          <View style={styles.maneuverGlyphBox}>
            {status.onRoute === false ? (
              <Ionicons name="sync" size={30} color={C.routeCore} />
            ) : status.maneuver ? (
              <ManeuverGlyph maneuver={status.maneuver} size={34} />
            ) : (
              <Ionicons name="navigate" size={30} color={C.routeCore} />
            )}
          </View>
          <View style={styles.maneuverTextCol}>
            {status.onRoute === false ? (
              <>
                <Text style={styles.maneuverDist}>מחשב מסלול מחדש…</Text>
                <Text style={styles.maneuverLabel} numberOfLines={1}>
                  {status.distanceM} מ׳ מחוץ למסלול
                </Text>
              </>
            ) : status.maneuver ? (
              <>
                <Text style={styles.maneuverDist}>{maneuverDist(status.maneuver)}</Text>
                <Text style={styles.maneuverLabel} numberOfLines={2}>
                  {maneuverLabel(status.maneuver)}
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.maneuverDist}>מנווט…</Text>
                <Text style={styles.maneuverLabel} numberOfLines={1}>אל היעד</Text>
              </>
            )}
          </View>
          {/* PHASE 48: controls cluster. The banner is row-reverse (RTL), so this
              being the LAST child puts it on the LEFT, with the glyph, distance
              and street name reading right-to-left beside it. One place to look
              for guidance, one place to reach for controls.

              The red exit returns here after Phase 47 moved it to the bottom
              dashboard — which Phase 48 scrapped. Worth being explicit that this
              trades away the thumb-reachability argument I made for the bottom
              position: the top-left corner is the hardest part of a phone to
              reach one-handed in a cradle. It's a deliberate call in favour of
              consolidating all guidance and its controls in one place, and the
              hitSlop below widens the target to compensate. */}
          <View style={styles.bannerCtlRow}>
            <Pressable
              style={styles.bannerEndBtn}
              onPress={cancelPreview}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="\u05e1\u05d9\u05d5\u05dd \u05e0\u05d9\u05d5\u05d5\u05d8"
            >
              <Ionicons name="close" size={22} color="#FFFFFF" />
            </Pressable>
            {/* Muted keeps the Phase 47 styling: a state the driver must be able
                to read at a glance, not just a different glyph in one colour. */}
            <Pressable
              style={[styles.voiceBtn, !voiceOn && styles.voiceBtnMuted]}
              onPress={toggleVoice}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityState={{ selected: !voiceOn }}
              accessibilityLabel={voiceOn ? "\u05d4\u05e9\u05ea\u05e7 \u05d4\u05e0\u05d7\u05d9\u05d5\u05ea \u05e7\u05d5\u05dc\u05d9\u05ea" : "\u05d4\u05e4\u05e2\u05dc \u05d4\u05e0\u05d7\u05d9\u05d5\u05ea \u05e7\u05d5\u05dc\u05d9\u05ea"}
            >
              <Ionicons
                name={voiceOn ? "volume-high" : "volume-mute"}
                size={20}
                color={voiceOn ? C.text : "#FF8A8A"}
              />
            </Pressable>
          </View>
        </Pressable>

          {/* Phase 33: TURN LANE GUIDANCE — one arrow per lane at the upcoming
              junction, in the real left-to-right order the driver faces. Lanes
              valid for this maneuver glow; the rest stay dim, so the panel
              answers "which lane am I supposed to be in" at a glance rather
              than needing to be read. Only shown inside LANE_ASSIST_M and only
              when lane data actually resolved — an invented layout would be
              worse than none.

              PHASE 48 moved it from a separately floating card into this group,
              directly under the banner and sharing its rounded shell, so the
              driver has ONE place to look for guidance instead of two boxes
              with a gap between them. */}
          {laneAssist && (
            <View style={styles.laneAssistAttached} pointerEvents="none">
              <View style={styles.laneAssistRow}>
              {laneAssist.lanes.map((lane, i) => (
                <View
                  key={i}
                  style={[styles.laneCell, lane.valid && styles.laneCellValid]}
                >
                  <Ionicons
                    name="arrow-up"
                    size={lane.valid ? 26 : 22}
                    color={lane.valid ? "#EAFFFF" : "rgba(190,205,225,0.38)"}
                    style={{ transform: [{ rotate: `${laneArrowAngle(lane)}deg` }] }}
                  />
                  {/* a lane can permit several movements; show the extras small */}
                  {lane.indications.length > 1 && (
                    <View style={styles.laneSubRow}>
                      {lane.indications.slice(1, 3).map((ind, j) => (
                        <Ionicons
                          key={j}
                          name="arrow-up"
                          size={11}
                          color={
                            lane.valid ? "rgba(234,255,255,0.75)" : "rgba(190,205,225,0.25)"
                          }
                          style={{
                            transform: [
                              { rotate: `${LANE_ARROW_ROTATION[ind] ?? 0}deg` },
                            ],
                          }}
                        />
                      ))}
                    </View>
                  )}
                </View>
              ))}
            </View>
            <View style={styles.laneAssistFooter}>
              <Text style={styles.laneAssistHint}>
                {status.maneuver ? maneuverDist(status.maneuver) : ""} · היכנס לנתיב
              </Text>
              {/* Synthesised layouts are labelled. The guidance is confident
                  either way, but a driver should be able to tell a derived
                  layout from a surveyed one. */}
              {laneAssist.inferred && <Text style={styles.laneAssistInferred}>משוער</Text>}
            </View>
            </View>
          )}
        </View>
      </View>
      )}

      {/* Phase 24: live-map presence chip. Tells the driver the map is social
          and decodes the badge letters, which are otherwise cryptic. Sits under
          the left column (which is 118pt tall) so the two never collide. */}
      {phase !== "preview" && nearbyCount > 0 && (
        <View
          style={[styles.livePill, { top: insets.top + 12 + (proximity ? 86 : 0) + 130 }]}
          pointerEvents="none"
        >
          <View style={styles.liveDot} />
          <Text style={styles.livePillText}>
            {nearbyCount} {nearbyCount === 1 ? "נהג בקרבתך" : "נהגים בקרבתך"}
          </Text>
        </View>
      )}

      {/* Phase 28: TRAFFIC LIGHT COUNTDOWN — the Gaode/Baidu signature card.
          Appears only on approach (<300m) while driving. Left-anchored under
          the maneuver card so it never collides with the hazard banner (top),
          the speed pill (bottom-left) or the status chip (bottom-right). */}
      {phase === "driving" && nextSignal && signalCountdown && (
        <View
          style={[
            styles.signalCard,
            {
              top: topStackTop + guidanceGroupH + 12, // clears the whole group
            },
          ]}
          pointerEvents="none"
        >
          {/* three-lamp housing — the inactive lamps stay dim, like the real thing */}
          <View style={styles.signalHousing}>
            <View
              style={[
                styles.signalLamp,
                { backgroundColor: signalCountdown.green ? "#1B3A22" : C.red },
                !signalCountdown.green && styles.signalLampLit,
              ]}
            />
            <View style={[styles.signalLamp, { backgroundColor: "#3A3320" }]} />
            <View
              style={[
                styles.signalLamp,
                { backgroundColor: signalCountdown.green ? C.green : "#14301C" },
                signalCountdown.green && styles.signalLampLit,
              ]}
            />
          </View>

          <View style={styles.signalTextCol}>
            <Text
              style={[
                styles.signalCountdown,
                { color: signalCountdown.green ? C.green : C.red },
              ]}
            >
              {signalCountdown.secondsLeft}
            </Text>
            <Text style={styles.signalUnit}>שניות</Text>
          </View>

          <View style={styles.signalMetaCol}>
            <Text style={styles.signalState}>
              {signalCountdown.green ? "ירוק" : "אדום"}
            </Text>
            <Text style={styles.signalDist}>{fmtDistance(nextSignal.distanceM)}</Text>
            {/* Honest labelling: the cycle is simulated, and an inferred
                light says so explicitly — never implied surveyed fact. */}
            <Text style={styles.signalSim}>
              {nextSignal.sig.inferred ? "רמזור משוער" : "הערכה"}
            </Text>
          </View>
        </View>
      )}

      {/* Idle top-LEFT column: hamburger + driver profile. Mirrors the right
          column, and both shift down while a hazard banner is up so the
          full-width alert can never sit on top of them. */}
      {phase === "idle" && (
        <View
          style={[styles.leftStack, { top: insets.top + 12 + (proximity ? 86 : 0) }]}
          pointerEvents="box-none"
        >
          <Pressable style={styles.menuBtn} onPress={() => setNotice("תפריט צד — בקרוב")} hitSlop={8}>
            <Ionicons name="menu" size={26} color={C.glassText} />
            <View style={styles.menuDot} />
          </Pressable>
          {/* Driver profile — points, distance and rank (Phase 22) */}
          <Pressable style={styles.avatarBtn} onPress={openProfile} hitSlop={8}>
            <Ionicons name="person" size={24} color="#FFFFFF" />
          </Pressable>
        </View>
      )}

      {/* Idle top-right: ONE column, top-anchored, so nothing can collide with
          the bottom sheet. Previously the report tile was pinned to
          bottom+340 with no zIndex, which put it *behind* the (taller) sheet.
          The dead "music" placeholder is gone. */}
      {phase === "idle" && (
        <View
          style={[styles.fabStack, { top: insets.top + 12 + (proximity ? 86 : 0) }]}
          pointerEvents="box-none"
        >
          {/* voice settings — a REAL control that mutes turn-by-turn guidance */}
          <Pressable style={styles.fab} onPress={toggleVoice} hitSlop={6}>
            <Ionicons name={voiceOn ? "volume-high" : "volume-mute"} size={22} color={C.glassText} />
          </Pressable>
          {/* traffic report — opens the report menu */}
          <Pressable style={styles.reportFab} onPress={() => setReportOpen(true)} hitSlop={6}>
            <Ionicons name="warning" size={26} color="#1A1200" />
          </Pressable>
        </View>
      )}

      {/* Phase 10 shell: bottom sheet — the primary idle interaction zone.
          bottom tracks the keyboard so the input never hides behind it. */}
      {phase === "idle" && (
      <View
        style={[
          styles.sheet,
          {
            // iOS: keyboard is an overlay, so we lift. Android: the OS already
            // resized the window (adjustResize) — lifting again is what caused
            // the collapse loop, so stay pinned at 0.
            bottom: KEYBOARD_LIFTS_SHEET && keyboardH > 0 ? keyboardH : 0,
            paddingBottom: keyboardH > 0 ? 16 : insets.bottom + 16,
          },
        ]}
      >
        <View style={styles.sheetGrip} />

        {/* Phase 25: save-mode banner. Makes it obvious that the next search
            pick will be STORED, not driven to — and gives a way out. */}
        {pendingSaveLabel && (
          <Pressable style={styles.saveModeBar} onPress={cancelSavePlace}>
            <Ionicons
              name={pendingSaveLabel === HOME_LABEL ? "home" : pendingSaveLabel === WORK_LABEL ? "briefcase" : "star"}
              size={18}
              color={C.wazeBlue}
            />
            <Text style={styles.saveModeText} numberOfLines={1}>
              {pendingSaveLabel === HOME_LABEL
                ? "בחר כתובת לשמירה כבית"
                : pendingSaveLabel === WORK_LABEL
                  ? "בחר כתובת לשמירה כעבודה"
                  : "בחר מקום לשמירה"}
            </Text>
            <Text style={styles.saveModeCancel}>ביטול</Text>
          </Pressable>
        )}

        {/* search bar — memoized, so telemetry re-renders never touch it */}
        <SearchBar
          value={query}
          onChangeText={onQueryChange}
          onSubmit={submitSearch}
          onClear={clearQuery}
          styles={styles}
          subColor={theme.sheetSub}
        />

        {/* autocomplete results replace the quick actions while typing.
            Scrollable + keyboardShouldPersistTaps so rows stay tappable with
            the keyboard open, and capped so the list never runs off-screen. */}
        {suggestions.length > 0 ? (
          <ScrollView
            style={styles.suggestScroll}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {suggestions.map((s, i) => (
              <Pressable
                key={`${s.lon},${s.lat},${i}`}
                style={[styles.suggestRow, i > 0 && styles.suggestDivider]}
                onPress={() => chooseSuggestion(s)}
              >
                <Text style={styles.suggestName}>{s.name}</Text>
                {!!s.detail && <Text style={styles.suggestDetail}>{s.detail}</Text>}
              </Pressable>
            ))}
          </ScrollView>
        ) : (
          <>
            {/* Phase 17 category chips — each fires a real category_search.
                The active chip is highlighted and tapping it again closes the
                panel. keyboardShouldPersistTaps so a tap registers while the
                keyboard is open instead of only dismissing it. */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.categoryScrollContent}
            >
              {SEARCH_CATEGORIES.map((c) => {
                const on = activeCategory === c.key;
                return (
                  <Pressable
                    key={c.key}
                    style={[styles.categoryChip, on && styles.categoryChipActive]}
                    onPress={() => onCategoryPress(c.key)}
                  >
                    <Ionicons name={c.icon} size={18} color={on ? "#FFFFFF" : c.color} />
                    <Text style={[styles.categoryChipLabel, on && styles.categoryChipLabelActive]}>
                      {c.label}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>

            {activeCategory ? (
              /* category results — nearest first, straight from Overpass */
              <View>
                <View style={styles.listHeaderRow}>
                  <Text style={styles.recentHeader}>
                    {SEARCH_CATEGORIES.find((c) => c.key === activeCategory)?.label ?? ""} בקרבתך
                  </Text>
                  <Pressable onPress={clearCategory} hitSlop={8}>
                    <Text style={styles.listHeaderAction}>נקה</Text>
                  </Pressable>
                </View>
                {/* Coarser fallback results are labelled rather than silently
                    swapped in, so a thinner list has a visible explanation. */}
                {categorySource === "nominatim" && categoryItems.length > 0 && (
                  <Text style={styles.listNote}>תוצאות מקורבות — מקור חלופי</Text>
                )}

                {categoryBusy ? (
                  <Text style={styles.listEmpty}>מחפש בקרבת מקום…</Text>
                ) : categoryError ? (
                  <Text style={styles.listEmpty}>החיפוש נכשל — נסה שוב</Text>
                ) : categoryItems.length === 0 ? (
                  <Text style={styles.listEmpty}>לא נמצאו תוצאות בקרבת מקום</Text>
                ) : (
                  <ScrollView
                    style={styles.suggestScroll}
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator={false}
                  >
                    {categoryItems.map((p, i) => (
                      <Pressable
                        key={`${p.lon},${p.lat},${i}`}
                        style={[styles.recentRow, i > 0 && styles.recentDivider]}
                        onPress={() => routeToPlace(p)}
                      >
                        <View style={styles.recentIconCircle}>
                          <Ionicons name="location" size={20} color={theme.sheetSub} />
                        </View>
                        <View style={styles.recentTextCol}>
                          <Text style={styles.recentTitle} numberOfLines={1}>{p.name}</Text>
                          {!!p.detail && (
                            <Text style={styles.recentDetail} numberOfLines={1}>{p.detail}</Text>
                          )}
                        </View>
                        {p.distanceM != null && (
                          <Text style={styles.placeDistance}>{fmtDistance(p.distanceM)}</Text>
                        )}
                      </Pressable>
                    ))}
                  </ScrollView>
                )}
              </View>
            ) : (
              <>
                {/* Phase 25: Home / Work quick navigate. Always present in idle —
                    set = one tap to drive there, unset = one tap to pick an
                    address. The star chip opens the full saved-places manager. */}
                <View style={styles.quickPlaceRow}>
                  <Pressable
                    style={[styles.quickPlaceChip, homePlace && styles.quickPlaceChipSet]}
                    onPress={() => onQuickPlacePress(HOME_LABEL, homePlace)}
                  >
                    <Ionicons
                      name={homePlace ? "home" : "home-outline"}
                      size={19}
                      color={homePlace ? "#FFFFFF" : theme.sheetSub}
                    />
                    <Text
                      style={[styles.quickPlaceLabel, homePlace && styles.quickPlaceLabelSet]}
                      numberOfLines={1}
                    >
                      בית
                    </Text>
                    {!homePlace && <Ionicons name="add" size={14} color={theme.sheetSub} />}
                  </Pressable>

                  <Pressable
                    style={[styles.quickPlaceChip, workPlace && styles.quickPlaceChipSet]}
                    onPress={() => onQuickPlacePress(WORK_LABEL, workPlace)}
                  >
                    <Ionicons
                      name={workPlace ? "briefcase" : "briefcase-outline"}
                      size={19}
                      color={workPlace ? "#FFFFFF" : theme.sheetSub}
                    />
                    <Text
                      style={[styles.quickPlaceLabel, workPlace && styles.quickPlaceLabelSet]}
                      numberOfLines={1}
                    >
                      עבודה
                    </Text>
                    {!workPlace && <Ionicons name="add" size={14} color={theme.sheetSub} />}
                  </Pressable>

                  <Pressable style={styles.quickPlaceMore} onPress={() => setPlacesOpen(true)}>
                    <Ionicons name="star" size={19} color={C.wazeYellow} />
                    {favouritePlaces.length > 0 && (
                      <View style={styles.quickPlaceBadge}>
                        <Text style={styles.quickPlaceBadgeText}>{favouritePlaces.length}</Text>
                      </View>
                    )}
                  </Pressable>
                </View>

              {/* Phase 20 recent searches — this device's real history from the
                 server. Each row carries lon/lat, so tapping routes directly. */}
              <View>
                {/* Phase 29: header row — title plus a trash affordance that
                    only appears when there's actually something to clear. */}
                <View style={styles.recentHeaderRow}>
                  <Text style={styles.recentHeader}>חיפושים אחרונים</Text>
                  {recent.length > 0 && (
                    <Pressable
                      onPress={clearHistory}
                      hitSlop={10}
                      style={styles.clearHistoryBtn}
                      accessibilityRole="button"
                      accessibilityLabel="מחק היסטוריה"
                    >
                      <Ionicons name="trash-outline" size={16} color={theme.sheetSub} />
                      <Text style={styles.clearHistoryText}>מחק היסטוריה</Text>
                    </Pressable>
                  )}
                </View>
                {recent.length === 0 ? (
                  <Text style={styles.listEmpty}>אין עדיין חיפושים אחרונים</Text>
                ) : (
                  recent.map((r, i) => (
                    <Pressable
                      key={`${r.lon},${r.lat},${i}`}
                      style={[styles.recentRow, i > 0 && styles.recentDivider]}
                      onPress={() => routeToPlace(r)}
                      // Phase 50: long-press deletes just this destination.
                      onLongPress={() => deleteRecentItem(r)}
                      delayLongPress={450}
                      accessibilityHint="לחיצה ארוכה מוחקת מההיסטוריה"
                    >
                      <View style={styles.recentIconCircle}>
                        <Ionicons name="time-outline" size={20} color={theme.sheetSub} />
                      </View>
                      <View style={styles.recentTextCol}>
                        <Text style={styles.recentTitle} numberOfLines={1}>{r.name}</Text>
                        {!!r.detail && (
                          <Text style={styles.recentDetail} numberOfLines={1}>{r.detail}</Text>
                        )}
                      </View>
                    </Pressable>
                  ))
                )}
              </View>
              </>
            )}
          </>
        )}

        {notice && (
          <View style={styles.noticeChip} pointerEvents="none">
            <Text style={styles.noticeChipText}>{notice}</Text>
          </View>
        )}
      </View>
      )}

      {/* compact status/connection chip — driving only (the bottom sheet owns
          idle bottom space now). Tap to change the server host. */}
      {phase === "driving" && (
      <Pressable
        style={[styles.statusChip, { bottom: rightRow2 }]}
        onPress={() => {
          setHostDraft(serverHost);
          setEditingHost(true);
        }}
      >
        <View style={[styles.dot, { backgroundColor: hud.dot }]} />
        <Text style={styles.statusChipText} numberOfLines={1}>
          {connected ? `${speedKmh ?? "–"} קמ״ש · ±${accM} m` : "link down — tap to set server"}
        </Text>
      </Pressable>
      )}

      {/* Re-center crosshairs. Shown in EVERY phase now, not just driving: a
          pan sets cameraMode to "free", which makes driveCamera() bail out on
          every subsequent fix. Previously there was no button in idle, so one
          accidental drag left the map permanently parked away from the driver
          with no way back short of restarting the app — which reads exactly
          like "my location is stuck". Sits above the bottom sheet in idle. */}
      {cameraMode === "free" && (
        <Pressable
          style={[
            styles.recenterBtn,
            {
              bottom: phase === "driving" ? rightRow3 : insets.bottom + 372,
            },
          ]}
          onPress={recenter}
        >
          <Ionicons name="locate" size={26} color={C.text} />
        </Pressable>
      )}

      {/* In-drive toast. At idle the bottom sheet already shows `notice` in its
          own chip; in driving/preview the sheet isn't mounted, so system
          messages (report_ack, another driver's report, reroute, route_error)
          would otherwise be invisible. Bottom-anchored by design — see the
          TOAST_BOTTOM_* notes — so it can't meet the top-anchored hazard
          banner, maneuver card or GPS strip. Tap to dismiss early. */}
      {phase !== "idle" && notice && (
        <Animated.View
          style={[
            styles.toast,
            {
              bottom:
                phase === "driving"
                  ? toastBottomDriving
                  : insets.bottom + TOAST_BOTTOM_PREVIEW,
              opacity: toastAnim,
              transform: [
                {
                  translateY: toastAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [14, 0],
                  }),
                },
              ],
            },
          ]}
          pointerEvents="box-none"
        >
          <Pressable style={styles.toastInner} onPress={() => setNotice(null)}>
            <Ionicons name="information-circle" size={20} color={C.wazeBlue} />
            <Text style={styles.toastText} numberOfLines={2}>
              {notice}
            </Text>
          </Pressable>
        </Animated.View>
      )}

      {/* Speedometer — memoized component untouched; only WHERE it renders
          changed. It's driving-only now: at idle the bottom sheet owns the
          lower screen, and the old `insets.bottom + 356` put the pill behind
          it (the sheet has zIndex 20, the pill had none). Bottom-LEFT while
          driving, clear of the status chip on the right. */}
      {/* Phase 46: bottom trip dashboard — ETA / distance / time left, and the
          only way to end a live route. Anchored to the safe-area bottom so it
          clears the iOS home indicator and Android gesture bar. */}
      {phase === "driving" && (
        <TripDashboard
          remainingM={status.remainingM}
          remainingS={status.remainingS}
          bottom={bottomEdge}
        />
      )}

      {phase === "driving" && (
        <Speedometer
          speedKmh={speedKmh}
          limitKmh={speedLimitKmh}
          bottom={bottomEdge}
        />
      )}

      {/* Phase 9: pre-drive route preview — slides up with ETA / distance / GO */}
      {phase === "preview" && pendingRoute && (
        <View style={[styles.previewCard, { paddingBottom: insets.bottom + 20 }]}>
          <View style={styles.previewGrip} />
          <Text style={styles.previewDest} numberOfLines={1}>
            {pendingRoute.properties?.name?.replace(/^To /, "") ?? "יעד"}
          </Text>
          {/* Phase 29: vehicle selector. Switching re-asks the server for the
              same trip on the chosen engine, so the stats below always describe
              the vehicle that's highlighted. RTL: car sits rightmost. */}
          <View style={styles.vehicleRow}>
            {VEHICLE_OPTIONS.map((v) => {
              const active = vehicle === v.key;
              return (
                <Pressable
                  key={v.key}
                  style={[styles.vehicleBtn, active && styles.vehicleBtnActive]}
                  onPress={() => chooseVehicle(v.key)}
                  hitSlop={4}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={v.label}
                >
                  <Ionicons
                    name={v.icon}
                    size={20}
                    color={active ? "#FFFFFF" : theme.sheetSub}
                  />
                  <Text style={[styles.vehicleLabel, active && styles.vehicleLabelActive]}>
                    {v.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <View style={styles.previewStatsRow}>
            <View style={styles.previewStat}>
              <Text style={styles.previewStatValue}>
                {pendingRoute.properties?.durationS != null
                  ? fmtDuration(pendingRoute.properties.durationS)
                  : "—"}
              </Text>
              <Text style={styles.previewStatLabel}>זמן נסיעה</Text>
            </View>
            <View style={styles.previewStatDivider} />
            <View style={styles.previewStat}>
              <Text style={styles.previewStatValue}>
                {pendingRoute.properties?.durationS != null
                  ? fmtEta(pendingRoute.properties.durationS)
                  : "—"}
              </Text>
              <Text style={styles.previewStatLabel}>הגעה</Text>
            </View>
            <View style={styles.previewStatDivider} />
            <View style={styles.previewStat}>
              <Text style={styles.previewStatValue}>
                {pendingRoute.properties?.distanceM != null
                  ? fmtDistance(pendingRoute.properties.distanceM)
                  : "—"}
              </Text>
              <Text style={styles.previewStatLabel}>מרחק</Text>
            </View>
          </View>
          <View style={styles.previewBtnRow}>
            <Pressable style={styles.previewGo} onPress={startDrive}>
              <View style={styles.previewGoAccent} />
              <Text style={styles.previewGoText}>לצאת עכשיו</Text>
            </Pressable>
            {/* Phase 25: one-tap save of the destination being previewed. */}
            <Pressable style={styles.previewSave} onPress={saveCurrentDestination} hitSlop={6}>
              <Ionicons name="star-outline" size={22} color={C.wazeYellow} />
            </Pressable>
            <Pressable style={styles.previewCancel} onPress={cancelPreview}>
              <Text style={styles.previewCancelText}>ביטול</Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* Phase 22: driver profile — bottom sheet, tap-outside to dismiss */}
      <Modal
        visible={profileOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setProfileOpen(false)}
      >
        <Pressable style={styles.reportBackdrop} onPress={() => setProfileOpen(false)}>
          {/* stop propagation so taps inside the sheet don't close it */}
          <Pressable
            style={[styles.reportSheet, { paddingBottom: insets.bottom + 24 }]}
            onPress={() => {}}
          >
            <View style={styles.reportHeader}>
              <Text style={styles.reportTitle}>הפרופיל שלי</Text>
              <Pressable style={styles.reportClose} onPress={() => setProfileOpen(false)} hitSlop={10}>
                <Ionicons name="close" size={22} color={theme.sheetSub} />
              </Pressable>
            </View>

            {/* rank badge — springs in on open */}
            <Animated.View
              style={[
                styles.rankBadgeWrap,
                {
                  opacity: badgeAnim,
                  transform: [
                    { scale: badgeAnim.interpolate({ inputRange: [0, 1], outputRange: [0.72, 1] }) },
                  ],
                },
              ]}
            >
              <View style={[styles.rankBadge, { backgroundColor: currentTier.color }]}>
                <Ionicons name={currentTier.icon} size={40} color="#FFFFFF" />
              </View>
              <Text style={styles.rankName}>{currentTier.label}</Text>
              {profileBusy && !profile ? (
                <Text style={styles.rankSub}>טוען נתונים…</Text>
              ) : profile && !profile.persisted ? (
                <Text style={styles.rankSub}>הנתונים אינם זמינים כרגע</Text>
              ) : nextTier ? (
                <Text style={styles.rankSub}>
                  עוד {Math.max(0, nextTier.minPoints - profilePoints)} נקודות ל{nextTier.label}
                </Text>
              ) : (
                <Text style={styles.rankSub}>הגעת לדרגה הגבוהה ביותר</Text>
              )}
            </Animated.View>

            {/* progress to the next rank — hidden at the top of the ladder */}
            {nextTier && (
              <View style={styles.progressTrack}>
                <Animated.View
                  style={[
                    styles.progressFill,
                    {
                      backgroundColor: currentTier.color,
                      width: progressAnim.interpolate({
                        inputRange: [0, 1],
                        outputRange: ["0%", "100%"],
                      }),
                    },
                  ]}
                />
              </View>
            )}

            {/* stat cards */}
            <View style={styles.statRow}>
              <View style={styles.statCard}>
                <Ionicons name="star" size={22} color={C.wazeYellow} />
                <Text style={styles.statValue}>{profile ? profile.points : "–"}</Text>
                <Text style={styles.statLabel}>נקודות</Text>
              </View>
              <View style={styles.statCard}>
                <Ionicons name="navigate" size={22} color={C.wazeBlue} />
                <Text style={styles.statValue}>
                  {profile ? profile.totalDistanceKm.toFixed(1) : "–"}
                </Text>
                <Text style={styles.statLabel}>ק״מ שנסעו</Text>
              </View>
            </View>

            {/* Phase 25: jump to the saved-places manager */}
            <Pressable
              style={styles.profilePlacesBtn}
              onPress={() => {
                setProfileOpen(false);
                setPlacesOpen(true);
              }}
            >
              <Ionicons name="star" size={18} color={C.wazeYellow} />
              <Text style={styles.profilePlacesText}>
                מקומות שמורים{savedPlaces.length ? ` (${savedPlaces.length})` : ""}
              </Text>
              <Ionicons name="chevron-back" size={18} color={theme.sheetSub} />
            </Pressable>

            {/* Friendly empty state. Only for a REAL zero (server answered and
                Mongo was up) — a DB outage says so above instead of implying
                the driver has earned nothing. */}
            {profile && profile.persisted && profile.points === 0 && profile.totalDistanceKm === 0 && (
              <View style={styles.emptyCard}>
                <Text style={styles.emptyTitle}>מתחילים לצבור נקודות</Text>
                <View style={styles.emptyRow}>
                  <Ionicons name="car-sport" size={18} color={theme.sheetSub} />
                  <Text style={styles.emptyText}>נקודה אחת על כל קילומטר נסיעה</Text>
                </View>
                <View style={styles.emptyRow}>
                  <Ionicons name="warning" size={18} color={theme.sheetSub} />
                  <Text style={styles.emptyText}>10 נקודות על כל דיווח על הדרך</Text>
                </View>
              </View>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Phase 26: driver interaction bubble. Opens when a marker is tapped;
          shows the target's rank and the two social actions. Modal (not an
          absolute view) so it captures the backdrop tap cleanly and can't be
          reached through by the map underneath. */}
      <Modal
        visible={!!tappedDriver}
        transparent
        animationType="fade"
        onRequestClose={() => setTappedDriver(null)}
      >
        <Pressable style={styles.driverBackdrop} onPress={() => setTappedDriver(null)}>
          {/* Positioned beside the tapped car when we know where the finger
              landed, clamped so it can never run off an edge; centred as a
              fallback when the press carried no screen point. */}
          <Pressable
            style={[
              styles.driverCard,
              tapPoint
                ? {
                    position: "absolute",
                    left: Math.min(
                      Math.max(12, tapPoint.x - DRIVER_CARD_W / 2),
                      Math.max(12, winW - DRIVER_CARD_W - 12)
                    ),
                    // Prefer above the marker; flip below if that would clip
                    // the top (status bar / notch).
                    top:
                      tapPoint.y - DRIVER_CARD_H - 24 > insets.top + 8
                        ? tapPoint.y - DRIVER_CARD_H - 24
                        : Math.min(tapPoint.y + 28, winH - DRIVER_CARD_H - 24),
                    width: DRIVER_CARD_W,
                  }
                : null,
            ]}
            onPress={() => {}}
          >
            {tappedDriver && (
              <>
                <View
                  style={[
                    styles.driverBadge,
                    { backgroundColor: tierFor(tappedDriver.rank).color },
                  ]}
                >
                  <Ionicons name={tierFor(tappedDriver.rank).icon} size={30} color="#FFFFFF" />
                </View>
                <Text style={styles.driverRank}>{tierFor(tappedDriver.rank).label}</Text>
                <Text style={styles.driverDist}>
                  {fmtDistance(tappedDriver.distanceM)} ממך
                </Text>

                <View style={styles.driverActions}>
                  <Pressable
                    style={[styles.driverAction, { backgroundColor: C.wazeYellow }]}
                    onPress={() => sendInteraction("honk")}
                  >
                    <Ionicons name="megaphone" size={26} color="#1A1200" />
                    <Text style={[styles.driverActionText, { color: "#1A1200" }]}>צפירה</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.driverAction, { backgroundColor: C.wazeBlue }]}
                    onPress={() => sendInteraction("like")}
                  >
                    <Ionicons name="thumbs-up" size={26} color="#FFFFFF" />
                    <Text style={[styles.driverActionText, { color: "#FFFFFF" }]}>לייק</Text>
                  </Pressable>
                </View>

                <Pressable onPress={() => setTappedDriver(null)} hitSlop={8}>
                  <Text style={styles.driverCancel}>סגירה</Text>
                </Pressable>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Phase 34: crowd validation. Tapping a report pin asks "עדיין שם?" —
          👍 refreshes confidence, 👎 counts toward retirement; the server
          removes the report for EVERYONE once its net score hits the
          threshold. Dark glass card so it reads identically over both
          basemaps in both themes. The emoji are React Native Text (device
          fonts) — the map-glyph range limit does not apply here. */}
      <Modal
        visible={!!voteTarget}
        transparent
        animationType="fade"
        onRequestClose={() => setVoteTarget(null)}
      >
        <Pressable style={styles.driverBackdrop} onPress={() => setVoteTarget(null)}>
          <Pressable style={styles.voteCard} onPress={() => {}}>
            {voteTarget && (
              <>
                <View
                  style={[
                    styles.voteIconWrap,
                    {
                      backgroundColor:
                        REPORT_OPTIONS.find((o) => o.type === voteTarget.reportType)?.color ??
                        C.amber,
                    },
                  ]}
                >
                  <Ionicons
                    name={
                      REPORT_OPTIONS.find((o) => o.type === voteTarget.reportType)?.icon ??
                      "warning"
                    }
                    size={28}
                    color="#FFFFFF"
                  />
                </View>
                <Text style={styles.voteTitle}>עדיין שם?</Text>
                <Text style={styles.voteSub}>
                  {REPORT_OPTIONS.find((o) => o.type === voteTarget.reportType)?.label ??
                    voteTarget.reportType}
                  {" · לפני "}
                  {Math.max(1, Math.round((nowTick - voteTarget.ts) / 60000))}
                  {" דק׳"}
                </Text>
                <View style={styles.voteRow}>
                  <Pressable
                    style={[styles.voteBtn, { backgroundColor: C.green }]}
                    onPress={() => sendVote("up")}
                  >
                    <Text style={styles.voteEmoji}>👍</Text>
                    <Text style={styles.voteBtnText}>כן, עדיין</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.voteBtn, { backgroundColor: C.red }]}
                    onPress={() => sendVote("down")}
                  >
                    <Text style={styles.voteEmoji}>👎</Text>
                    <Text style={styles.voteBtnText}>כבר לא</Text>
                  </Pressable>
                </View>
                <Pressable onPress={() => setVoteTarget(null)} hitSlop={8}>
                  <Text style={styles.voteCancel}>סגירה</Text>
                </Pressable>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Phase 25: saved places manager — view, navigate to, add and delete */}
      <Modal
        visible={placesOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setPlacesOpen(false)}
      >
        <Pressable style={styles.reportBackdrop} onPress={() => setPlacesOpen(false)}>
          <Pressable
            style={[styles.reportSheet, { paddingBottom: insets.bottom + 24 }]}
            onPress={() => {}}
          >
            <View style={styles.reportHeader}>
              <Text style={styles.reportTitle}>מקומות שמורים</Text>
              <Pressable style={styles.reportClose} onPress={() => setPlacesOpen(false)} hitSlop={10}>
                <Ionicons name="close" size={22} color={theme.sheetSub} />
              </Pressable>
            </View>

            {/* Home + Work always shown, set or not, so they can be created
                and re-assigned from one place. */}
            {[
              { label: HOME_LABEL, he: "בית", icon: "home" as IoniconName, place: homePlace },
              { label: WORK_LABEL, he: "עבודה", icon: "briefcase" as IoniconName, place: workPlace },
            ].map((row) => (
              <View key={row.label} style={styles.placeRow}>
                <View style={[styles.placeIconCircle, { backgroundColor: C.wazeBlue }]}>
                  <Ionicons name={row.icon} size={20} color="#FFFFFF" />
                </View>
                <Pressable
                  style={styles.placeTextCol}
                  onPress={() =>
                    row.place ? navigateToPlace(row.place) : beginSavePlace(row.label)
                  }
                >
                  <Text style={styles.placeTitle}>{row.he}</Text>
                  <Text style={styles.placeSub} numberOfLines={1}>
                    {row.place ? row.place.address || "נשמר" : "לא הוגדר — הקש להגדרה"}
                  </Text>
                </Pressable>
                {row.place ? (
                  <Pressable onPress={() => deletePlace(row.place!.placeId)} hitSlop={10}>
                    <Ionicons name="trash-outline" size={20} color={theme.sheetSub} />
                  </Pressable>
                ) : (
                  <Ionicons name="add-circle-outline" size={22} color={theme.sheetSub} />
                )}
              </View>
            ))}

            <Text style={[styles.recentHeader, { marginTop: 14 }]}>מועדפים</Text>
            {favouritePlaces.length === 0 ? (
              <Text style={styles.listEmpty}>
                אין מועדפים עדיין — שמור יעד ממסך התצוגה המקדימה
              </Text>
            ) : (
              <ScrollView style={styles.placesScroll} showsVerticalScrollIndicator={false}>
                {favouritePlaces.map((p) => (
                  <View key={p.placeId} style={styles.placeRow}>
                    <View style={[styles.placeIconCircle, { backgroundColor: C.wazeYellow }]}>
                      <Ionicons name="star" size={18} color="#1A1200" />
                    </View>
                    <Pressable style={styles.placeTextCol} onPress={() => navigateToPlace(p)}>
                      <Text style={styles.placeTitle} numberOfLines={1}>
                        {p.label}
                      </Text>
                      {!!p.address && (
                        <Text style={styles.placeSub} numberOfLines={1}>
                          {p.address}
                        </Text>
                      )}
                    </Pressable>
                    <Pressable onPress={() => deletePlace(p.placeId)} hitSlop={10}>
                      <Ionicons name="trash-outline" size={20} color={theme.sheetSub} />
                    </Pressable>
                  </View>
                ))}
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* runtime server-host editor */}
      {/* Phase 13: traffic report menu — bottom sheet, tap-outside to dismiss */}
      <Modal
        visible={reportOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setReportOpen(false)}
      >
        <Pressable style={styles.reportBackdrop} onPress={() => setReportOpen(false)}>
          {/* stop propagation so taps inside the sheet don't close it */}
          <Pressable style={[styles.reportSheet, { paddingBottom: insets.bottom + 20 }]} onPress={() => {}}>
            <View style={styles.reportHeader}>
              <Text style={styles.reportTitle}>דיווח על הדרך</Text>
              <Pressable style={styles.reportClose} onPress={() => setReportOpen(false)} hitSlop={10}>
                <Ionicons name="close" size={22} color={theme.sheetSub} />
              </Pressable>
            </View>
            <View style={styles.reportGrid}>
              {REPORT_OPTIONS.map((opt) => (
                <Pressable
                  key={opt.type}
                  style={styles.reportItem}
                  onPress={() => submitReport(opt.type)}
                >
                  <View style={[styles.reportIconWrap, { backgroundColor: opt.color }]}>
                    <Ionicons name={opt.icon} size={30} color="#FFFFFF" />
                  </View>
                  <Text style={styles.reportLabel}>{opt.label}</Text>
                </Pressable>
              ))}
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={editingHost}
        transparent
        animationType="fade"
        onRequestClose={() => setEditingHost(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Server host</Text>
            <Text style={styles.modalHint}>
              Usually auto-detected — only needed if that fails. Your PC's LAN IP
              and port, e.g. 10.96.103.157:3000. Phone and PC
              must share a network — "localhost" here means the phone itself.
            </Text>
            <TextInput
              style={styles.modalInput}
              value={hostDraft}
              onChangeText={setHostDraft}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              keyboardType="url"
              placeholder="192.168.1.42:3000 or myapp.up.railway.app"
              placeholderTextColor={C.textDim}
            />
            <View style={styles.modalRow}>
              <Pressable style={styles.modalBtn} onPress={() => setEditingHost(false)}>
                <Text style={styles.modalBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.modalBtn, styles.modalBtnPrimary]}
                onPress={() => {
                  const v = hostDraft.trim();
                  if (v) setServerHost(normalizeHostInput(v, SERVER_PORT));
                  setEditingHost(false);
                }}
              >
                <Text style={styles.modalBtnText}>Connect</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ---------- theming (Phase 16) ----------
// C holds the theme-INDEPENDENT constants: the dark driving HUD (glass
// maneuver card, speed pill, status chip), the route ribbon, and the brand
// accents. Its sheet* values double as the LIGHT theme's source of truth.
const C = {
  route: "#2D6BFF",
  routeCore: "#5EC8FF",   // bright inner core of the route ribbon
  routeGlow: "#1E4FD0",   // outer glow
  routeCasing: "#0B3D91",
  arrow: "#FFFFFF",
  building: "#1B2436",     // extruded building fill on the dark base
  green: "#22C55E",
  // Phase 40/42: active-lane corridor, solved backwards from the Gaode NIGHT
  // capture so the composite matches rather than the raw fill. Sampled target
  // #3BA58B. Re-solved in Phase 42 because lightening the asphalt moved the
  // backdrop: over the new #2D374E, #17E8A8 @0.18 then #43C69E @0.70 lands on
  // #3BA58B exactly (0/765 error). Also deliberately NOT `green` above — that's
  // the traffic-signal colour rendered at the same junction on the same screen.
  laneCorridor: "#43C69E",      // crisp ribbon core, @ 0.70
  laneCorridorGlow: "#17E8A8",  // wider emission underneath, @ 0.18
  laneCorridorRim: "#8FF5D2",   // brighter edge line down each side
  laneChevron: "#EBEEFF",       // sampled directly from the reference chevrons
  red: "#EF4444",
  amber: "#F59E0B",
  slate: "#94A3B8",
  hudBg: "rgba(10, 15, 26, 0.92)",
  // Phase 34 glassmorphism: the shared surface for everything FLOATING OVER
  // THE MAP. expo-blur was deliberately NOT added — it's a native module, so
  // it would force a full native rebuild for every developer and CI; a
  // translucent dark fill + hairline light border + soft shadow reads as
  // premium glass without any native cost, and stays legible over both
  // basemaps in both themes.
  glass: "rgba(20, 25, 40, 0.85)",
  glassBorder: "rgba(255, 255, 255, 0.14)",
  glassText: "#F2F4F8",
  panelTop: "#12305F",     // maneuver card gradient endpoints
  panelBottom: "#0B1E3D",
  text: "#F8FAFC",
  textDim: "#94A3B8",
  // idle-shell light values (LIGHT theme source of truth)
  sheetBg: "#FFFFFF",
  sheetText: "#1A1A2E",
  sheetSub: "#8A8AA0",
  sheetField: "#F0F0F4",       // search bar + quick-card fill
  sheetBorder: "#E6E6EE",
  wazeBlue: "#0A6CFF",         // primary action + accent text
  wazeBlueDark: "#0850C4",     // trailing segment on the GO button
  wazeYellow: "#FFD21E",       // report tile
  grip: "#D0D0DA",
};

// Only the idle shell re-themes; everything reading C directly does not.
type Theme = {
  sheetBg: string;
  sheetText: string;
  sheetSub: string;
  sheetField: string;
  sheetBorder: string;
  grip: string;
  backdrop: string;
};

const LIGHT: Theme = {
  sheetBg: C.sheetBg,
  sheetText: C.sheetText,
  sheetSub: C.sheetSub,
  sheetField: C.sheetField,
  sheetBorder: C.sheetBorder,
  grip: C.grip,
  backdrop: "rgba(0,0,0,0.4)",
};

const DARK: Theme = {
  sheetBg: "#151A26",
  sheetText: "#F2F4F8",
  sheetSub: "#8B93A7",
  sheetField: "#232A3A",
  sheetBorder: "#2E3648",
  grip: "#3A4256",
  backdrop: "rgba(0,0,0,0.55)",
};

// Speedometer: STATIC sheet — identical in both themes (dark HUD over the
// map), and static so a theme flip can never re-render the memoized pill.
// Phase 46. Static sheet for the same reason speedStyles is one: the dashboard
// keeps its dark HUD look over the map in both themes, so the theme flip must
// not be able to re-render it.
const tripStyles = StyleSheet.create({
  // PHASE 48: was a full-width bar across the bottom, which cost a strip of road
  // the driver actually needs to see. Now a compact right-hand pill: same glass
  // shell as the top guidance group, roughly a third of the width, and the exit
  // has moved back into the banner so this surface carries metrics only.
  pill: {
    position: "absolute",
    right: 16,
    zIndex: 30,
    minWidth: 132,
    paddingHorizontal: 14,
    paddingVertical: 9,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: C.glass,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(120,200,255,0.4)",
    shadowColor: "#000",
    shadowOpacity: 0.5,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 18,
  },
  primary: {
    color: "#FFFFFF",
    fontSize: 22,
    fontWeight: "800",
    lineHeight: 26,
    textAlign: "center",
  },
  secondary: {
    color: "rgba(255,255,255,0.68)",
    fontSize: 12,
    fontWeight: "600",
    marginTop: 1,
    textAlign: "center",
  },
});

const speedStyles = StyleSheet.create({
  // Phase 44: the group is what's positioned now, so the sign and the pill stay
  // locked together as one HUD block instead of each needing its own offset.
  hud: {
    position: "absolute",
    left: 16,
    zIndex: 30,
    alignItems: "center",
    gap: 8,
  },
  pillWrap: { width: 76, height: 76, alignItems: "center", justifyContent: "center" },
  halo: {
    position: "absolute",
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: C.red,
  },
  pill: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: "rgba(10,15,26,0.94)",
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.85)",
    alignItems: "center",
    justifyContent: "center",
  },
  // Vienna Convention limit sign: white disc, red annulus, black numeral.
  sign: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: "#FFFFFF",
    borderWidth: 7,
    borderColor: "#D8232A",
    alignItems: "center",
    justifyContent: "center",
  },
  signText: {
    color: "#0B0B0B",
    fontSize: 21,
    fontWeight: "900",
    lineHeight: 24,
    textAlign: "center",
  },
  value: { color: "#FFFFFF", fontSize: 30, fontWeight: "800", lineHeight: 32, textAlign: "center" },
  unit: { color: C.textDim, fontSize: 11, marginTop: 0, textAlign: "center" },
  // Over-speed alert. Phase 44 moved this from a red FILL with white text to
  // red NUMERALS on the dark HUD, per spec. Large saturated digits on near-black
  // read as fast as a red blob does and stay legible as a NUMBER, which matters
  // when the thing the driver needs is the value, not just the alarm.
  pillAlert: {
    borderColor: C.red,
    borderWidth: 3,
  },
  valueAlert: { color: "#FF4D4D" },
  unitAlert: { color: "rgba(255,120,120,0.95)" },
});

// Setup-error screen: static, always dark (it renders before any theming matters).
const setupStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0A0F1A",
    justifyContent: "center",
    padding: 24,
    gap: 12,
  },
  title: { color: C.red, fontSize: 18, fontWeight: "700" },
  text: { color: C.textDim, fontSize: 14, lineHeight: 20 },
  code: {
    color: C.text,
    fontSize: 13,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    backgroundColor: "rgba(255,255,255,0.08)",
    padding: 10,
    borderRadius: 8,
  },
});

// The themed stylesheet. Rebuilt only when the theme flips (twice a day at
// most, via the useMemo in MapScreenInner). Idle-shell surfaces read the
// Theme t; the dark driving HUD and route accents keep reading C.
function makeStyles(t: Theme) {
  return StyleSheet.create({
    container: { flex: 1 },
    map: { flex: 1 },
    // thin colored strip at the very top (off-route cue) — no more full border
    topStrip: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      height: 4,
      zIndex: 40,
    },
    // Waze-style GPS warning banner
    gpsBanner: {
      position: "absolute",
      top: Platform.OS === "ios" ? 52 : 34,
      left: 16,
      right: 16,
      zIndex: 40,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      backgroundColor: "#7A5B00", // dark amber, high contrast
      borderRadius: 12,
      paddingVertical: 9,
      paddingHorizontal: 14,
      borderWidth: 1,
      borderColor: C.amber,
    },
    gpsText: { color: "#FFFFFF", fontSize: 13, fontWeight: "600" },
    // ---- atmospheric horizon (Phase 31) ----
    // Sits at the very top of the viewport, under all HUD chrome (zIndex 5 vs
    // 20-50 for the cards), so it hazes the distance without dimming any UI.
    horizonHaze: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      height: 170,
      zIndex: 5,
    },
    hazeBand: {
      flex: 1,
      backgroundColor: t.sheetBg === "#FFFFFF" ? "#AFC4DE" : "#0A1020",
    },
    // top stack lowered so it never collides with the map compass
    topStack: {
      // PHASE 45: `top` is set inline from useSafeAreaInsets, NOT here. It used
      // to be a hardcoded `Platform.OS === "ios" ? 104 : 88`, which was the one
      // top-of-screen element in the app not deriving its offset from the safe
      // area — every other one (proximityBanner, leftStack, fabStack, livePill)
      // already used insets.top. On hardware whose inset falls outside the
      // assumed range the constant is simply wrong: too low on a tall notch,
      // and ~60px of wasted screen on a device with no notch at all.
      position: "absolute",
      left: 16,
      right: 16,
      zIndex: 30,
      gap: 10,
    },
    searchRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      backgroundColor: t.sheetField,
      borderRadius: 26,
      paddingHorizontal: 18,
      paddingVertical: 6,
    },
    searchClear: { padding: 4 },
    // Phase 10: bottom sheet (idle) — themed
    sheet: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 20,
      backgroundColor: t.sheetBg,
      borderTopLeftRadius: 26,
      borderTopRightRadius: 26,
      paddingHorizontal: 16,
      paddingTop: 10,
      shadowColor: "#000",
      shadowOpacity: 0.22,
      shadowRadius: 24,
      shadowOffset: { width: 0, height: -4 },
      elevation: 16,
      gap: 16,
    },
    sheetGrip: {
      alignSelf: "center",
      width: 44,
      height: 5,
      borderRadius: 3,
      backgroundColor: t.grip,
      marginBottom: 2,
    },
    // Phase 14: category chips (horizontal scroll)
    categoryScrollContent: { flexDirection: "row-reverse", gap: 10, paddingVertical: 2 },
    categoryChip: {
      flexDirection: "row-reverse", // RTL: icon on the right, label to its left
      alignItems: "center",
      gap: 7,
      paddingVertical: 9,
      paddingHorizontal: 14,
      borderRadius: 20,
      backgroundColor: t.sheetField,
      borderWidth: 1,
      borderColor: t.sheetBorder,
    },
    categoryChipLabel: { color: t.sheetText, fontSize: 14, fontWeight: "600" },
    // selected chip: filled with the app accent so the active filter is obvious
    categoryChipActive: { backgroundColor: C.wazeBlue, borderColor: C.wazeBlue },
    categoryChipLabelActive: { color: "#FFFFFF" },
    listHeaderRow: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "space-between",
    },
    listHeaderAction: { color: C.wazeBlue, fontSize: 13, fontWeight: "700" },
    listNote: { color: t.sheetSub, fontSize: 11, fontWeight: "600", textAlign: "right", marginTop: -2 },
    listEmpty: {
      color: t.sheetSub,
      fontSize: 14,
      textAlign: "right",
      paddingVertical: 14,
    },
    placeDistance: { color: t.sheetSub, fontSize: 12, fontWeight: "600" },
    // Phase 21 V2X hazard banner — highest z-index in the app on purpose.
    proximityBanner: {
      position: "absolute",
      left: 12,
      right: 12,
      zIndex: 50,
      flexDirection: "row-reverse", // RTL: icon right, text to its left
      alignItems: "center",
      gap: 14,
      backgroundColor: C.red,
      borderRadius: 18,
      paddingVertical: 14,
      paddingHorizontal: 16,
      borderWidth: 2,
      borderColor: "#FFFFFF",
      shadowColor: "#000",
      shadowOpacity: 0.45,
      shadowRadius: 16,
      shadowOffset: { width: 0, height: 6 },
      elevation: 24,
    },
    proximityIconWrap: {
      width: 46,
      height: 46,
      borderRadius: 23,
      backgroundColor: "rgba(0,0,0,0.22)",
      alignItems: "center",
      justifyContent: "center",
    },
    proximityTextCol: { flex: 1, alignItems: "flex-end" },
    proximityTitle: { color: "#FFFFFF", fontSize: 19, fontWeight: "800", textAlign: "right" },
    proximityDist: { color: "rgba(255,255,255,0.95)", fontSize: 15, fontWeight: "700", marginTop: 1 },
    // Phase 14: recent searches
    recentHeader: {
      color: t.sheetSub,
      fontSize: 13,
      fontWeight: "600",
      textAlign: "right",
      marginBottom: 4,
    },
    // Phase 29: header row holding the title and the clear-history affordance.
    // RTL: title on the right, the destructive action on the far left.
    recentHeaderRow: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "space-between",
    },
    clearHistoryBtn: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 5,
      paddingVertical: 4,
      paddingHorizontal: 8,
      borderRadius: 12,
      backgroundColor: t.sheetField,
      marginBottom: 4,
    },
    clearHistoryText: { color: t.sheetSub, fontSize: 12, fontWeight: "600" },
    recentRow: {
      flexDirection: "row-reverse", // RTL: clock icon on the right, text to its left
      alignItems: "center",
      gap: 12,
      paddingVertical: 10,
    },
    recentDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.sheetBorder },
    recentIconCircle: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: t.sheetField,
      alignItems: "center",
      justifyContent: "center",
    },
    recentTextCol: { flex: 1, alignItems: "flex-end" },
    recentTitle: { color: t.sheetText, fontSize: 16, fontWeight: "600", textAlign: "right" },
    recentDetail: { color: t.sheetSub, fontSize: 13, marginTop: 2, textAlign: "right" },
    // ---- saved places (Phase 25) ----
    quickPlaceRow: { flexDirection: "row-reverse", gap: 10, alignItems: "center" },
    quickPlaceChip: {
      flex: 1,
      flexDirection: "row-reverse", // RTL: icon right, label to its left
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      paddingVertical: 12,
      paddingHorizontal: 12,
      borderRadius: 16,
      backgroundColor: t.sheetField,
      borderWidth: 1,
      borderColor: t.sheetBorder,
    },
    // "set" chips are filled, so a glance tells you which are configured
    quickPlaceChipSet: { backgroundColor: C.wazeBlue, borderColor: C.wazeBlue },
    quickPlaceLabel: { color: t.sheetText, fontSize: 14, fontWeight: "700" },
    quickPlaceLabelSet: { color: "#FFFFFF" },
    quickPlaceMore: {
      width: 52,
      paddingVertical: 12,
      borderRadius: 16,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: t.sheetField,
      borderWidth: 1,
      borderColor: t.sheetBorder,
    },
    quickPlaceBadge: {
      position: "absolute",
      top: 4,
      right: 6,
      minWidth: 16,
      height: 16,
      borderRadius: 8,
      paddingHorizontal: 4,
      backgroundColor: C.wazeBlue,
      alignItems: "center",
      justifyContent: "center",
    },
    quickPlaceBadgeText: { color: "#FFFFFF", fontSize: 10, fontWeight: "800" },
    saveModeBar: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 10,
      paddingVertical: 10,
      paddingHorizontal: 14,
      borderRadius: 14,
      backgroundColor: t.sheetField,
      borderWidth: 1,
      borderColor: C.wazeBlue,
    },
    saveModeText: { flex: 1, color: t.sheetText, fontSize: 13, fontWeight: "700", textAlign: "right" },
    saveModeCancel: { color: C.wazeBlue, fontSize: 13, fontWeight: "700" },
    placeRow: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 12,
      paddingVertical: 11,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.sheetBorder,
    },
    placeIconCircle: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: "center",
      justifyContent: "center",
    },
    placeTextCol: { flex: 1, alignItems: "flex-end" },
    placeTitle: { color: t.sheetText, fontSize: 15, fontWeight: "700", textAlign: "right" },
    placeSub: { color: t.sheetSub, fontSize: 12, marginTop: 2, textAlign: "right" },
    placesScroll: { maxHeight: 220 },
    profilePlacesBtn: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 10,
      marginTop: 16,
      paddingVertical: 14,
      paddingHorizontal: 16,
      borderRadius: 16,
      backgroundColor: t.sheetField,
    },
    profilePlacesText: { flex: 1, color: t.sheetText, fontSize: 15, fontWeight: "700", textAlign: "right" },
    previewSave: {
      width: 56,
      borderRadius: 28,
      backgroundColor: t.sheetField,
      alignItems: "center",
      justifyContent: "center",
    },
    // Phase 10: top-left profile / menu button — themed tile + red dot
    menuBtn: {
      width: 52,
      height: 52,
      borderRadius: 16,
      backgroundColor: C.glass,
      borderWidth: 1,
      borderColor: C.glassBorder,
      alignItems: "center",
      justifyContent: "center",
      shadowColor: "#000",
      shadowOpacity: 0.3,
      shadowRadius: 14,
      shadowOffset: { width: 0, height: 4 },
      elevation: 8,
    },
    menuDot: {
      position: "absolute",
      top: 10,
      right: 10,
      width: 9,
      height: 9,
      borderRadius: 5,
      backgroundColor: C.red,
    },
    // Phase 10: right-side floating action button stack — themed circles
    // Two mirrored top corner columns. Both are top-anchored and shift down
    // together when a hazard banner appears, so neither can be covered by it.
    leftStack: { position: "absolute", left: 16, zIndex: 30, gap: 14, alignItems: "center" },
    // Phase 24: live-map presence chip (left edge, under the corner column)
    livePill: {
      position: "absolute",
      left: 16,
      zIndex: 30,
      flexDirection: "row-reverse", // RTL: dot on the right
      alignItems: "center",
      gap: 8,
      backgroundColor: C.glass,
      borderRadius: 18,
      paddingVertical: 8,
      paddingHorizontal: 12,
      borderWidth: 1,
      borderColor: C.glassBorder,
      shadowColor: "#000",
      shadowOpacity: 0.3,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
      elevation: 8,
    },
    liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.green },
    // ---- turn lane guidance HUD (Phase 33) ----
    // Dark glass in both themes: it sits over the map beside the maneuver card,
    // and a light panel there would glare at night.
    // NOT row-reverse: lane order is physical left-to-right as the driver faces
    // the junction, so it must not follow RTL text direction.
    // PHASE 48: the attached lane box. Square, flat, and separated from the
    // banner above it by a single hairline — the group clips the outer corners.
    laneAssistAttached: {
      alignItems: "center",
      gap: 6,
      paddingVertical: 10,
      paddingHorizontal: 12,
      backgroundColor: "rgba(0,0,0,0.22)",
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: "rgba(125,249,255,0.35)",
    },
    laneAssistRow: { flexDirection: "row", alignItems: "flex-end", gap: 6 },
    laneCell: {
      minWidth: 40,
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 8,
      paddingHorizontal: 4,
      borderRadius: 10,
      backgroundColor: "rgba(255,255,255,0.05)",
    },
    // the lane(s) to be in — lit, tinted and ringed
    laneCellValid: {
      backgroundColor: "rgba(0,229,255,0.18)",
      borderWidth: 1.5,
      borderColor: "#00E5FF",
    },
    laneSubRow: { flexDirection: "row", gap: 2, marginTop: 2 },
    laneAssistFooter: {
      flexDirection: "row-reverse",
      alignItems: "center",
      gap: 8,
    },
    laneAssistHint: {
      color: "rgba(255,255,255,0.8)",
      fontSize: 12,
      fontWeight: "700",
      textAlign: "center",
    },
    // marks a synthesised layout — same treatment as the simulated traffic
    // light countdown, for consistency
    laneAssistInferred: {
      color: "rgba(125,249,255,0.7)",
      fontSize: 9,
      fontWeight: "700",
    },
    // ---- traffic light countdown card (Phase 28) ----
    // Dark glass in BOTH themes: it sits over the map next to the maneuver
    // card, and a light panel there would glare at night.
    signalCard: {
      position: "absolute",
      left: 16,
      zIndex: 30,
      flexDirection: "row-reverse", // RTL: housing right, text flowing left
      alignItems: "center",
      gap: 12,
      backgroundColor: "rgba(10,18,32,0.92)",
      borderRadius: 20,
      paddingVertical: 12,
      paddingHorizontal: 14,
      borderWidth: 1,
      borderColor: "rgba(125,249,255,0.45)",
      shadowColor: "#00E5FF",
      shadowOpacity: 0.4,
      shadowRadius: 16,
      shadowOffset: { width: 0, height: 4 },
      elevation: 14,
    },
    signalHousing: {
      gap: 4,
      padding: 5,
      borderRadius: 9,
      backgroundColor: "#05080F",
      borderWidth: 1,
      borderColor: "rgba(255,255,255,0.16)",
    },
    signalLamp: { width: 13, height: 13, borderRadius: 7, opacity: 0.35 },
    // the active lamp gets full opacity plus a coloured bloom
    signalLampLit: {
      opacity: 1,
      shadowColor: "#FFFFFF",
      shadowOpacity: 0.9,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 0 },
      elevation: 6,
    },
    signalTextCol: { alignItems: "center", minWidth: 46 },
    signalCountdown: { fontSize: 34, fontWeight: "800", lineHeight: 36 },
    signalUnit: { color: "rgba(255,255,255,0.6)", fontSize: 10, fontWeight: "600" },
    signalMetaCol: { alignItems: "flex-end", gap: 1 },
    signalState: { color: "#FFFFFF", fontSize: 14, fontWeight: "800" },
    signalDist: { color: "rgba(255,255,255,0.75)", fontSize: 12, fontWeight: "600" },
    signalSim: { color: "rgba(125,249,255,0.7)", fontSize: 9, fontWeight: "700" },
    // ---- driver interaction bubble (Phase 26) ----
    driverBackdrop: {
      flex: 1,
      backgroundColor: t.backdrop,
      alignItems: "center",
      justifyContent: "center",
      padding: 32,
    },
    driverCard: {
      width: "100%",
      maxWidth: 340,
      alignItems: "center",
      gap: 10,
      backgroundColor: t.sheetBg,
      borderRadius: 24,
      paddingVertical: 24,
      paddingHorizontal: 22,
      shadowColor: "#000",
      shadowOpacity: 0.3,
      shadowRadius: 20,
      shadowOffset: { width: 0, height: 8 },
      elevation: 20,
    },
    driverBadge: {
      width: 68,
      height: 68,
      borderRadius: 34,
      alignItems: "center",
      justifyContent: "center",
    },
    driverRank: { color: t.sheetText, fontSize: 19, fontWeight: "800" },
    driverDist: { color: t.sheetSub, fontSize: 13, fontWeight: "600" },
    driverActions: { flexDirection: "row-reverse", gap: 12, marginTop: 8, alignSelf: "stretch" },
    driverAction: {
      flex: 1,
      alignItems: "center",
      gap: 6,
      paddingVertical: 16,
      borderRadius: 18,
    },
    driverActionText: { fontSize: 14, fontWeight: "800" },
    driverCancel: { color: t.sheetSub, fontSize: 14, fontWeight: "700", marginTop: 6 },
    // ---- report vote popup (Phase 34) ----
    // Dark glass regardless of theme: it floats over the map like the HUD
    // cards, and the light text keeps it legible on both basemaps.
    voteCard: {
      width: "100%",
      maxWidth: 320,
      alignItems: "center",
      gap: 8,
      backgroundColor: "rgba(20, 25, 40, 0.94)",
      borderRadius: 24,
      paddingVertical: 24,
      paddingHorizontal: 22,
      borderWidth: 1,
      borderColor: C.glassBorder,
      shadowColor: "#000",
      shadowOpacity: 0.4,
      shadowRadius: 22,
      shadowOffset: { width: 0, height: 10 },
      elevation: 22,
    },
    voteIconWrap: {
      width: 56,
      height: 56,
      borderRadius: 28,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 2,
    },
    voteTitle: { color: "#F5F8FF", fontSize: 20, fontWeight: "800" },
    voteSub: { color: "rgba(235,242,255,0.72)", fontSize: 13, fontWeight: "600" },
    voteRow: { flexDirection: "row-reverse", gap: 12, marginTop: 12, alignSelf: "stretch" },
    voteBtn: { flex: 1, alignItems: "center", gap: 4, paddingVertical: 14, borderRadius: 18 },
    voteEmoji: { fontSize: 24 },
    voteBtnText: { fontSize: 13, fontWeight: "800", color: "#FFFFFF" },
    voteCancel: { color: "rgba(235,242,255,0.6)", fontSize: 14, fontWeight: "700", marginTop: 8 },
    livePillText: { color: C.glassText, fontSize: 12, fontWeight: "700" },
    fabStack: { position: "absolute", right: 16, zIndex: 30, gap: 14, alignItems: "center" },
    // Driver profile entry point — filled accent circle so it reads as a
    // persona/account control rather than another map utility button.
    avatarBtn: {
      width: 52,
      height: 52,
      borderRadius: 26,
      backgroundColor: C.wazeBlue,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 2,
      borderColor: t.sheetBg,
      shadowColor: "#000",
      shadowOpacity: 0.24,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 2 },
      elevation: 7,
    },
    // Phase 34: floating map controls share one dark-glass surface in BOTH
    // themes — they sit over the map, not the sheet, so theming them light
    // just made them glare over the night basemap.
    fab: {
      width: 52,
      height: 52,
      borderRadius: 26,
      backgroundColor: C.glass,
      borderWidth: 1,
      borderColor: C.glassBorder,
      alignItems: "center",
      justifyContent: "center",
      shadowColor: "#000",
      shadowOpacity: 0.3,
      shadowRadius: 14,
      shadowOffset: { width: 0, height: 4 },
      elevation: 8,
    },
    // report/hazard: yellow rounded-square tile (not a circle), like Waze —
    // brand yellow in BOTH themes
    reportFab: {
      width: 56,
      height: 56,
      borderRadius: 16,
      backgroundColor: C.wazeYellow,
      alignItems: "center",
      justifyContent: "center",
      shadowColor: "#000",
      shadowOpacity: 0.28,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 3 },
      elevation: 8,
    },
    // Prominent exit: solid fill, white content, larger tap target and a ring
    // so it separates from the translucent maneuver card behind it.
    endBtn: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      height: 48,
      paddingHorizontal: 18,
      borderRadius: 24,
      backgroundColor: C.red,
      borderWidth: 2,
      borderColor: "rgba(255,255,255,0.9)",
      shadowColor: "#000",
      shadowOpacity: 0.35,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 3 },
      elevation: 8,
    },
    endGlyph: { color: "#FFFFFF", fontSize: 16, fontWeight: "800" },
    // PHASE 48: shared shell for the banner + lane box. Radius, border and
    // shadow live HERE now so the two children can sit flush against each other
    // without a seam. overflow:"hidden" clips them to the radius.
    guidanceGroup: {
      borderRadius: 22,
      overflow: "hidden",
      backgroundColor: C.glass,
      borderWidth: 1,
      borderColor: "rgba(120,200,255,0.4)",
      shadowColor: "#000",
      shadowOpacity: 0.5,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 6 },
      // 18 seats the group just under the hazard strip (24) and clear of the
      // floating controls (8).
      elevation: 18,
    },
    maneuverBanner: {
      flexDirection: "row-reverse", // RTL: glyph on the right, text flows right-to-left
      alignItems: "center",
      gap: 14,
      // No background / radius / border / shadow: guidanceGroup owns all four.
      paddingVertical: 15,
      paddingHorizontal: 16,
    },
    maneuverGlyphBox: {
      width: 62,
      height: 62,
      borderRadius: 18,
      backgroundColor: C.panelBottom,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: "rgba(94,200,255,0.4)",
    },
    maneuverTextCol: { flex: 1, alignItems: "flex-end" },
    // Distance is the primary read, so it carries the largest type in the app's
    // HUD layer. allowFontScaling is left ON here (unlike the speedometer):
    // this is prose-adjacent and a driver who scales system text up wants it.
    maneuverDist: { color: "#FFFFFF", fontSize: 31, fontWeight: "800", letterSpacing: 0.2, lineHeight: 35, textAlign: "right" },
    maneuverLabel: { color: "rgba(255,255,255,0.94)", fontSize: 16, fontWeight: "600", lineHeight: 20, marginTop: 2, textAlign: "right" },
    // PHASE 48: mute + exit, side by side. Vertical would push the banner
    // taller than the 62px glyph box; horizontal keeps its height unchanged.
    bannerCtlRow: { flexDirection: "row-reverse", alignItems: "center", gap: 8 },
    bannerEndBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: C.red,
      alignItems: "center",
      justifyContent: "center",
    },
    voiceBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: C.panelBottom,
      alignItems: "center",
      justifyContent: "center",
    },
    // Muted is a STATE the driver must be able to read at a glance, not just a
    // different glyph in the same colour.
    voiceBtnMuted: {
      backgroundColor: "rgba(239,68,68,0.22)",
      borderWidth: 1.5,
      borderColor: C.red,
    },
    searchInput: {
      flex: 1,
      paddingVertical: 10,
      color: t.sheetText,
      fontSize: 16,
    },
    suggestScroll: { maxHeight: 260 },
    suggestRow: { paddingVertical: 13, paddingHorizontal: 6, flexDirection: "column", alignItems: "flex-end" },
    suggestDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.sheetBorder },
    suggestName: { color: t.sheetText, fontSize: 16, fontWeight: "600", textAlign: "right" },
    suggestDetail: { color: t.sheetSub, fontSize: 13, marginTop: 2, textAlign: "right" },
    recenterBtn: {
      position: "absolute",
      right: 16,
      zIndex: 30,
      width: 54,
      height: 54,
      borderRadius: 27,
      backgroundColor: C.glass,
      borderWidth: 1.5,
      borderColor: C.route, // brand accent — this is the "find me" control
      alignItems: "center",
      justifyContent: "center",
      shadowColor: "#000",
      shadowOpacity: 0.3,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
      elevation: 8,
    },
    previewCard: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 20,
      backgroundColor: t.sheetBg,
      borderTopLeftRadius: 26,
      borderTopRightRadius: 26,
      paddingHorizontal: 20,
      paddingTop: 10,
      paddingBottom: 34,
      shadowColor: "#000",
      shadowOpacity: 0.22,
      shadowRadius: 24,
      shadowOffset: { width: 0, height: -4 },
      elevation: 16,
    },
    previewGrip: {
      alignSelf: "center",
      width: 44,
      height: 5,
      borderRadius: 3,
      backgroundColor: t.grip,
      marginBottom: 16,
    },
    previewDest: { color: t.sheetText, fontSize: 22, fontWeight: "800", marginBottom: 16, textAlign: "right" },
    // Phase 29: vehicle selector — a segmented control above the trip stats.
    // RTL row so "רכב" (the default) sits rightmost, matching reading order.
    vehicleRow: {
      flexDirection: "row-reverse",
      gap: 8,
      marginBottom: 16,
    },
    vehicleBtn: {
      flex: 1,
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      paddingVertical: 10,
      borderRadius: 14,
      backgroundColor: t.sheetField,
      borderWidth: 1,
      borderColor: t.sheetBorder,
    },
    vehicleBtnActive: {
      backgroundColor: C.wazeBlue,
      borderColor: C.wazeBlue,
    },
    vehicleLabel: { color: t.sheetSub, fontSize: 13, fontWeight: "700" },
    vehicleLabelActive: { color: "#FFFFFF" },
    previewStatsRow: { flexDirection: "row-reverse", alignItems: "center", marginBottom: 20 },
    previewStat: { flex: 1, alignItems: "center" },
    previewStatDivider: { width: StyleSheet.hairlineWidth, height: 34, backgroundColor: t.sheetBorder },
    previewStatValue: { color: t.sheetText, fontSize: 21, fontWeight: "800" },
    previewStatLabel: { color: t.sheetSub, fontSize: 12, marginTop: 3 },
    previewBtnRow: { flexDirection: "row-reverse", gap: 12 },
    previewCancel: {
      paddingVertical: 16,
      paddingHorizontal: 22,
      borderRadius: 28,
      backgroundColor: t.sheetField,
      alignItems: "center",
      justifyContent: "center",
    },
    previewCancelText: { color: C.wazeBlue, fontSize: 15, fontWeight: "700" },
    previewGo: {
      flex: 1,
      borderRadius: 28,
      backgroundColor: C.wazeBlue,
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
      flexDirection: "row",
    },
    previewGoAccent: {
      position: "absolute",
      left: 0,
      top: 0,
      bottom: 0,
      width: 56,
      backgroundColor: C.wazeBlueDark,
    },
    previewGoText: { color: "#FFFFFF", fontSize: 18, fontWeight: "800", paddingVertical: 16 },
    noticeChip: {
      alignSelf: "flex-end",
      backgroundColor: t.sheetField,
      borderRadius: 12,
      paddingVertical: 7,
      paddingHorizontal: 12,
    },
    noticeChipText: { color: t.sheetSub, fontSize: 12, textAlign: "right" },
    // In-drive toast — same themed surface language as the sheet, so it reads
    // as part of the app in both light and dark. zIndex 45 keeps it under the
    // hazard banner (50) but over every other floating control (30).
    toast: {
      position: "absolute",
      left: 16,
      right: 16,
      zIndex: 45,
      alignItems: "center",
    },
    toastInner: {
      flexDirection: "row-reverse", // RTL: icon right, message to its left
      alignItems: "center",
      gap: 10,
      maxWidth: "100%",
      backgroundColor: t.sheetBg,
      borderRadius: 16,
      paddingVertical: 12,
      paddingHorizontal: 16,
      borderWidth: 1,
      borderColor: t.sheetBorder,
      shadowColor: "#000",
      shadowOpacity: 0.28,
      shadowRadius: 14,
      shadowOffset: { width: 0, height: 5 },
      elevation: 12,
    },
    toastText: {
      flexShrink: 1,
      color: t.sheetText,
      fontSize: 14,
      fontWeight: "600",
      textAlign: "right",
    },
    // compact connection chip, bottom-right — dark HUD in both themes
    statusChip: {
      position: "absolute",
      right: 16,
      zIndex: 30,
      flexDirection: "row",
      alignItems: "center",
      gap: 7,
      backgroundColor: C.glass,
      borderWidth: 1,
      borderColor: C.glassBorder,
      borderRadius: 20,
      paddingVertical: 7,
      paddingHorizontal: 12,
      maxWidth: 220,
    },
    statusChipText: { color: C.textDim, fontSize: 12 },
    dot: { width: 9, height: 9, borderRadius: 5 },
    // Phase 13: report menu — themed sheet over a themed backdrop
    reportBackdrop: {
      flex: 1,
      backgroundColor: t.backdrop,
      justifyContent: "flex-end",
    },
    reportSheet: {
      backgroundColor: t.sheetBg,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      paddingHorizontal: 20,
      paddingTop: 16,
    },
    reportHeader: {
      flexDirection: "row-reverse",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 18,
    },
    reportTitle: { color: t.sheetText, fontSize: 19, fontWeight: "800" },
    reportClose: {
      width: 34,
      height: 34,
      borderRadius: 17,
      backgroundColor: t.sheetField,
      alignItems: "center",
      justifyContent: "center",
    },
    reportGrid: {
      flexDirection: "row-reverse",
      flexWrap: "wrap",
      justifyContent: "space-between",
      rowGap: 16,
    },
    reportItem: {
      width: "48%",
      alignItems: "center",
      paddingVertical: 18,
      borderRadius: 16,
      backgroundColor: t.sheetField,
      gap: 10,
    },
    reportIconWrap: {
      width: 58,
      height: 58,
      borderRadius: 29,
      alignItems: "center",
      justifyContent: "center",
    },
    reportLabel: { color: t.sheetText, fontSize: 15, fontWeight: "700" },
    // ---- driver profile sheet (Phase 22) ----
    rankBadgeWrap: { alignItems: "center", gap: 8, marginBottom: 18 },
    rankBadge: {
      width: 92,
      height: 92,
      borderRadius: 46,
      alignItems: "center",
      justifyContent: "center",
      shadowColor: "#000",
      shadowOpacity: 0.3,
      shadowRadius: 14,
      shadowOffset: { width: 0, height: 6 },
      elevation: 10,
    },
    rankName: { color: t.sheetText, fontSize: 22, fontWeight: "800", marginTop: 4 },
    rankSub: { color: t.sheetSub, fontSize: 13, fontWeight: "600", textAlign: "center" },
    progressTrack: {
      height: 8,
      borderRadius: 4,
      backgroundColor: t.sheetField,
      overflow: "hidden",
      marginBottom: 20,
      // RTL: fill grows from the right edge, matching the reading direction
      flexDirection: "row-reverse",
    },
    progressFill: { height: "100%", borderRadius: 4 },
    statRow: { flexDirection: "row-reverse", gap: 12 },
    statCard: {
      flex: 1,
      alignItems: "center",
      gap: 6,
      paddingVertical: 18,
      borderRadius: 16,
      backgroundColor: t.sheetField,
    },
    statValue: { color: t.sheetText, fontSize: 26, fontWeight: "800" },
    statLabel: { color: t.sheetSub, fontSize: 12, fontWeight: "600" },
    emptyCard: {
      marginTop: 16,
      padding: 16,
      borderRadius: 16,
      backgroundColor: t.sheetField,
      borderWidth: 1,
      borderColor: t.sheetBorder,
      gap: 10,
    },
    emptyTitle: { color: t.sheetText, fontSize: 15, fontWeight: "800", textAlign: "right" },
    emptyRow: { flexDirection: "row-reverse", alignItems: "center", gap: 10 },
    emptyText: { color: t.sheetSub, fontSize: 13, flexShrink: 1, textAlign: "right" },
    // runtime host editor — dark dev tool in both themes
    modalBackdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.6)",
      justifyContent: "center",
      padding: 24,
    },
    modalCard: {
      backgroundColor: "#0F172A",
      borderRadius: 16,
      padding: 20,
      gap: 10,
    },
    modalTitle: { color: C.text, fontSize: 16, fontWeight: "700" },
    modalHint: { color: C.textDim, fontSize: 12, lineHeight: 17 },
    modalInput: {
      color: C.text,
      fontSize: 15,
      fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
      backgroundColor: "rgba(255,255,255,0.08)",
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    modalRow: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 4 },
    modalBtn: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 8 },
    modalBtnPrimary: { backgroundColor: C.route },
    modalBtnText: { color: C.text, fontSize: 14, fontWeight: "600" },
  });
}

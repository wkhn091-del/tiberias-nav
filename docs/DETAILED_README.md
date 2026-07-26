# Tiberias Nav — Route 90 PoC (Phase 1)

Track a phone along the Highway 90 corridor through Tiberias and get live
on-route / off-route feedback: green screen edge when you're inside the ±30 m
corridor, red when you're off it, with distance-to-centerline and progress
along the route streamed back in real time.

Stack: React Native (Expo dev build) + MapLibre React Native · Node.js
(Express 5 + ws) + Turf.js · MongoDB with 2dsphere indexes · Python geo
pipeline (OSM Overpass → Shapely → seed).

Architecture diagram: `docs/architecture.mermaid` (paste into mermaid.live to render).

## Layout

```
tiberias_nav/
├── geo-pipeline/
│   ├── extract_route_90.py    # OSM → centerline + buffer polygon → MongoDB
│   ├── on_route_check.py      # standalone math validator (EPSG:2039)
│   └── requirements.txt
├── server/
│   ├── server.js              # REST + WebSocket /track + on-route engine
│   ├── simulate_ping.js       # fake client: drives the route, detours off it
│   └── package.json           # verified: express 5, ws 8, mongoose 9, turf 7
├── app/
│   ├── MapScreen.tsx          # map + GPS watcher + WS client + color-coded HUD
│   ├── App.tsx                # entry-point wiring (blank-typescript template)
│   ├── set_server_ip.js       # writes the dev machine's LAN IP into .env
│   └── app.json.example       # required Expo config plugins
└── docs/
    └── architecture.mermaid
```

## Prerequisites

Node 18+, Python 3.10+, Docker (for MongoDB), and Android Studio or Xcode
(MapLibre needs a native dev build — it cannot run in Expo Go).

## Run order (the full loop)

### 1. MongoDB

```bash
docker run -d --name h90-mongo -p 27017:27017 -v h90data:/data/db mongo:7
```

### 2. Seed the route

```bash
cd geo-pipeline
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python extract_route_90.py --dry-run   # writes hwy90_tiberias.geojson — inspect at geojson.io
python extract_route_90.py             # looks right? seed MongoDB
```

If Route 90 is dual-carriageway in the extract, the script logs it and uses
the longest strand as the PoC centerline. The query unions `ref=90` ways with
the Route 90 road-relation members (bbox-clipped) for full corridor coverage,
and sends a `User-Agent` header — Overpass answers anonymous clients with 406.
After seeding, open `hwy90_tiberias.geojson` at geojson.io and confirm the
strand spans the full stretch you intend to drive.

### 3. Server

```bash
cd ../server
npm install
npm run dev
```

You must see `Route loaded: Highway 90 - Tiberias corridor (X.XX km)`.
A "log-only mode" warning means step 2 didn't land. Sanity check:
`curl localhost:3000/health` → `{"ok":true,"routeLoaded":true}`.

### 4. Mobile app

```bash
npx create-expo-app@latest highway90-app --template blank-typescript
cd highway90-app
npx expo install @maplibre/maplibre-react-native@^11 expo-location
# copy app/MapScreen.tsx, app/App.tsx and app/set_server_ip.js into the project root
# merge the "plugins" array from app/app.json.example into app.json
node set_server_ip.js       # optional — pins the server host in .env
npx expo prebuild --clean
npx expo run:android        # or run:ios — dev build, not Expo Go
```

Host resolution is automatic: the app honors `EXPO_PUBLIC_SERVER_HOST` from
`.env` (written by `set_server_ip.js`) and otherwise derives the dev machine's
IP from the Metro bundler host — so when server.js runs on the same machine as
`expo start`, zero config is needed. Phone and machine must share a network;
re-run the script and restart Metro after switching networks.
Dev builds allow cleartext `ws://`; production moves to `wss://`.

## Simulate a client (no phone needed)

Telemetry is WebSocket-only — `POST /ping` answers 426 with directions. With
the server running and the route seeded:

```bash
cd server
node simulate_ping.js               # drive the corridor at ~54 km/h, detour off-route mid-way
node simulate_ping.js --stay-on     # skip the detour
node simulate_ping.js --teleport    # instant sideways jump → the glitch filter rejects it
PING_MS=250 STEP_M=10 node simulate_ping.js   # faster run (keep STEP_M/(PING_MS/1000) < 70 m/s)
```

Expect ON route at meter-level distances, a ramp into OFF route during the
detour, matching `[ping]` lines in the server console, and rising `progress`.

## Field test

Expected behavior: green edge + ON ROUTE 90 with single-digit distances along
the corridor; red within seconds one block uphill into the city.

The server's `[ping]` log lines are the dataset — device, coordinates,
`onRoute`, distance to centerline (m), progress along the route (m).

Tuning knobs if downtown GPS makes the border flicker red on-road:
`ON_ROUTE_THRESHOLD_M` in server.js and `--buffer` on the extraction
(re-run it) — try 40–50 m. If flicker persists, add hysteresis: only flip
state after 2–3 consecutive contrary fixes. Also watch whether `progress`
increases monotonically while driving; jumps near junctions mark where the
Phase 2 per-direction centerlines are needed.

## Troubleshooting

**MapLibre API generations — `Element type is invalid` / missing exports** —
the package renamed its API twice: v9 exposes a default namespace
(`MapLibreGL.MapView`), v10 exposes named `MapView`/`ShapeSource`/`LineLayer`,
and **v11 (current — what this app targets) renamed again: `Map`,
`GeoJSONSource`, a unified `Layer`, `Camera initialViewState` +
`trackUserLocation`, `UserLocation heading/accuracy`**. Keep code and package
on the same generation and pin `"@maplibre/maplibre-react-native": "^11"`.
`npm ls @maplibre/maplibre-react-native` must show exactly one entry at 11.x.
MapScreen's setup screen self-diagnoses which generation is installed
(v9 / v10 / empty / healthy). A major switch swaps the native SDK too — after
any version change, `npx expo prebuild --clean` + `npx expo run:android` are
mandatory; a JS reload (`r`) is not enough. (RN 0.86 also removed
`StyleSheet.absoluteFillObject` — the code uses an explicit absolute fill.)

**`Tried to register two views with the same name MLRNCamera`** — the native
view registered twice: duplicate package copies/versions, the unscoped
`maplibre-react-native` fork installed alongside the scoped package, or manual
registration in MainApplication on top of Expo autolinking. In an Expo project
`android/` is generated output; the correct amount of manual native config for
MapLibre is zero. Recovery:

```powershell
npm uninstall maplibre-react-native @rnmapbox/maps @react-native-mapbox-gl/maps
Remove-Item -Recurse -Force node_modules; npm install
npx expo install @maplibre/maplibre-react-native@^11 expo-location
npx expo-doctor
npx expo prebuild --clean    # deletes android/ incl. manual edits — that's the point
npx expo run:android
```

**Overpass answers 406** — anonymous clients are rejected; the script already
sends a `User-Agent` header.

**`POST /ping` answers 426** — telemetry is WebSocket-only; use
`node simulate_ping.js` or connect to `ws://HOST:3000/track`.

**Route seeded after the server started** — no restart needed: the server
re-checks for the route whenever a client connects, and the app re-fetches the
route line on every reconnect.

## Re-archive after edits

bash / macOS / Linux:

```bash
zip -r tiberias_nav.zip tiberias_nav -x "tiberias_nav/server/node_modules/*" -x "tiberias_nav/geo-pipeline/.venv/*"
```

PowerShell (delete `server\node_modules` and `geo-pipeline\.venv` first —
`Compress-Archive` has no exclude flag):

```powershell
Compress-Archive -Path .\tiberias_nav -DestinationPath .\tiberias_nav.zip -Force
```

## Phase 2 (already staged in the data)

The seeded buffer polygon enables indexed `$geoIntersects` on-route checks in
MongoDB, and `progressM` buckets pings into route segments — the basis for
average segment speed, i.e. the traffic layer.

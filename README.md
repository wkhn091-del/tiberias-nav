# Tiberias Nav — Route 90 PoC

Two independent apps plus a data pipeline, each in its own folder with its own
dependencies. The mobile app and the server run separately and never share a
`package.json`.

```
tiberias_nav/
├── server/          Node.js backend — its own package.json (express, ws, mongoose, turf)
│   ├── server.js
│   ├── simulate_ping.js
│   └── package.json
├── mobile_app/      Expo app — its own package.json (expo 57, expo-router, MapLibre v11)
│   ├── app/                 expo-router routes
│   │   ├── _layout.tsx
│   │   └── index.tsx        the "/" screen → mounts the map
│   ├── components/
│   │   └── MapScreen.tsx    map + GPS watcher + WS client + on-route HUD
│   ├── assets/
│   ├── app.json             Android package + the 3 required plugins
│   ├── package.json
│   ├── set_server_ip.js
│   ├── babel.config.js
│   └── tsconfig.json
├── geo-pipeline/    Python — OSM → route → MongoDB
│   ├── extract_route_90.py
│   ├── on_route_check.py
│   └── requirements.txt
└── docs/
    ├── SYSTEM_OVERVIEW.md   how the whole system works — baseline knowledge
    ├── DETAILED_README.md
    └── architecture.mermaid
```

Both `package.json` files were installed and verified: `mobile_app` resolves
with no peer conflicts on Expo SDK 57, `npx tsc` passes with zero errors
against the real installed types, and `npx expo config` resolves all three
plugins and detects SDK 57.

## Why the old "missing package.json" happened

The mobile app and server files had been flattened into one folder with a
single mixed `package.json`, so from `mobile_app` Expo found no valid manifest.
Here each app owns its manifest and they never overlap.

---

## Build the mobile app from a clean start

Prerequisites: Node 18+, and Android Studio (SDK + an emulator or a USB device
with USB debugging). MapLibre needs a native dev build — **Expo Go will not
work.**

```bash
cd mobile_app
npm install                 # installs Expo 57, expo-router, MapLibre v11 (~600 pkgs)
node set_server_ip.js       # optional: writes your PC's LAN IP into .env
npx expo prebuild --clean   # generates the native android/ project
npx expo run:android        # builds + installs the dev client, starts Metro
```

That's it — no manual `android/` edits, ever. `android/` is generated output;
if a build breaks, delete it and re-run `prebuild --clean`.

After the first build, day-to-day you only need `npx expo start` (or press `r`
in the Metro terminal to reload JS). You only rebuild natively when native
dependencies or app.json change.

### Host resolution (phone ↔ server) — read this before EAS builds

Resolution lives in `mobile_app/lib/serverHost.ts` (unit-tested against every
Metro host-string shape). Order: **runtime override** (tap the status card,
type `host:port`) → **`EXPO_PUBLIC_SERVER_HOST`** → **Metro host auto-detect**
→ localhost.

**The automatic answer for local dev — no IP typing, ever:**

```bash
eas build --profile development --platform android   # once (or: npx expo run:android)
# install the dev build, then every day just:
npx expo start
```

The dev/dev-client build served by `expo start` receives Metro's host — your
PC's *current* LAN IP — through `expo-constants`, and `getServerHost()` reuses
it for the API server (server + Metro run on the same PC here). Router hands
out a new IP tomorrow? Metro reports the new one; you change nothing.

**Why this needs the dev-client build, not a standalone APK:** `hostUri` is
only populated when a live Metro serves the bundle. A standalone EAS APK embeds
its bundle — no Metro, so auto-detect can't apply and it falls back to
localhost (the HUD says so and invites a tap). For standalone field-test APKs,
bake the IP instead:

- **Local builds:** `.env` in `mobile_app/` — `EXPO_PUBLIC_SERVER_HOST=IP:3000`.
  `EXPO_PUBLIC_*` is baked at build time; restart Metro after editing.
- **EAS cloud builds:** EAS does **not** upload a gitignored `.env`. Set the
  variable under the profile's `"env"` in `eas.json` — the `preview` profile
  already does. Update the IP there, then
  `eas build --profile preview --platform android`.

`localhost` on a phone always means the phone itself.

---

## Run the server (separately)

```bash
cd server
npm install
docker run -d --name h90-mongo -p 27017:27017 -v h90data:/data/db mongo:7
npm run dev                 # expect: "Route loaded: Highway 90 - Tiberias corridor (X.XX km)"
```

Seed the route first if you haven't (see geo-pipeline below), or the server
runs in log-only mode until a client connects and it retries.

Desk test without a phone:

```bash
node simulate_ping.js       # drives the corridor, detours off-route mid-way
```

---

## Seed the route (geo-pipeline)

```bash
cd geo-pipeline
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python extract_route_90.py --dry-run   # writes hwy90_tiberias.geojson — check at geojson.io
python extract_route_90.py             # looks right? seed MongoDB
```

---

## MapLibre version note (important)

This app targets **@maplibre/maplibre-react-native v11** — API `Map`,
`GeoJSONSource`, `Layer`, `Camera initialViewState` + `trackUserLocation`,
`UserLocation heading/accuracy`. v9 (`MapLibreGL.*`) and v10
(`MapView`/`ShapeSource`/`LineLayer`) are **different, incompatible APIs**.
`package.json` pins `^11`. If MapScreen ever shows the red "isn't linked
correctly" screen, it will name which generation is installed and what to
install — then a native rebuild (`prebuild --clean` + `run:android`) is
mandatory, because a version switch also swaps the native SDK.

## Windows: "Filename longer than 260 characters" during the CMake build

If `npx expo run:android` fails in the C++/CMake step (`ninja: error: Stat(...)
Filename longer than 260 characters`) for native modules, the cause is the
Android Gradle Plugin defaulting to **CMake 3.22.1**, which ships **ninja
1.10** — a version that ignores Windows long-path support. The Windows registry
`LongPathsEnabled` flag does not help, because that toolchain wasn't built to
honor it.

This project ships a config plugin — `plugins/withWindowsLongPathFix.js`,
already registered in `app.json` — that fixes it durably (survives `prebuild
--clean`) by (1) pinning a modern CMake (≥3.30 ships ninja ≥1.12, which honors
long paths) and (2) redirecting the deep `.cxx` intermediates to a short root
(`C:\b\<project>`). It's a no-op on macOS/Linux.

One manual prerequisite: install the pinned CMake into your SDK so Gradle can
find it.

```powershell
# Android Studio → SDK Manager → SDK Tools → Show Package Details → CMake → 3.31.x
# or via CLI:
sdkmanager --install "cmake;3.31.6"

# then a clean native rebuild:
cd mobile_app
npx expo prebuild --clean
npx expo run:android
```

Keep the project path itself short too (e.g. `C:\tnav\mobile_app`). If you
install a different CMake version, update `cmakeVersion` in the plugin's config
in `app.json`.

## Re-archive after edits

```bash
# from the folder containing tiberias_nav/
zip -r tiberias_nav.zip tiberias_nav \
  -x "tiberias_nav/mobile_app/node_modules/*" \
  -x "tiberias_nav/mobile_app/android/*" \
  -x "tiberias_nav/mobile_app/ios/*" \
  -x "tiberias_nav/server/node_modules/*" \
  -x "tiberias_nav/geo-pipeline/.venv/*"
```

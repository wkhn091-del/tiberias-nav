// simulate_ping.js — drive a fake client along the seeded Route 90 corridor.
//
// Telemetry in this project is WebSocket-only (ws://HOST/track); REST only
// serves the route and /health. This script stands in for the phone: it
// fetches the route from the server, "drives" along it at ~54 km/h, ramps
// off-route for a stretch in the middle, comes back, and prints every status
// reply. Watch the server console for the matching [ping] lines.
//
// Run from the server/ folder (it uses this folder's node_modules):
//   node simulate_ping.js                 # full drive with an off-route detour
//   node simulate_ping.js --stay-on       # no detour
//   node simulate_ping.js --teleport      # jump sideways instantly -> the
//                                         # glitch filter rejects the ping
//   SERVER_HOST=192.168.1.42:3000 node simulate_ping.js
//   PING_MS=250 STEP_M=10 node simulate_ping.js   # faster run — keep
//                                         # STEP_M/(PING_MS/1000) under 70 m/s
//                                         # or the teleport filter kicks in

const WebSocket = require("ws");
const turf = require("@turf/turf");

if (typeof fetch !== "function") {
  console.error(`Node 18+ is required (global fetch). Current: ${process.version}`);
  process.exit(1);
}

const HOST = process.env.SERVER_HOST || "localhost:3000";
const STEP_M = Number(process.env.STEP_M || 15); // meters per ping
const PING_MS = Number(process.env.PING_MS || 1000);
const DETOUR_LON = 0.0009; // ~84 m eastward at Tiberias latitude — well past the 30 m corridor
const RAMP_PINGS = 4;      // pings to ramp on/off the detour (a car turns, it doesn't teleport)
const STAY_ON = process.argv.includes("--stay-on");
const TELEPORT = process.argv.includes("--teleport");

async function main() {
  const res = await fetch(`http://${HOST}/routes/hwy90-tiberias`).catch(() => null);
  if (!res || !res.ok) {
    console.error(
      `GET http://${HOST}/routes/hwy90-tiberias failed` +
        (res ? ` (${res.status})` : "") +
        " — is the server running and the route seeded?"
    );
    process.exit(1);
  }
  const feature = await res.json();
  const line = turf.lineString(feature.geometry.coordinates);
  const lengthM = turf.length(line, { units: "meters" });
  const speedMs = STEP_M / (PING_MS / 1000);

  console.log(`Route:  ${feature.properties?.name} — ${(lengthM / 1000).toFixed(2)} km`);
  console.log(
    `Drive:  ${(speedMs * 3.6).toFixed(0)} km/h, 1 ping/${PING_MS} ms` +
      (STAY_ON ? "" : TELEPORT ? ", instant off-route jump mid-way" : ", off-route detour mid-way")
  );

  // sample the centerline every STEP_M meters
  const samples = [];
  for (let d = 0; d <= lengthM; d += STEP_M) {
    samples.push(turf.along(line, d, { units: "meters" }).geometry.coordinates);
  }

  const ws = new WebSocket(`ws://${HOST}/track`);
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "status") {
      const state = m.onRoute === null ? "?? route not loaded" : m.onRoute ? "ON  route" : "OFF route";
      console.log(`   <- ${state}  dist=${m.distanceM} m  progress=${m.progressM} m (${m.progressPct}%)`);
    } else {
      console.log(`   <- ${m.type}: ${m.reason || m.message}`);
    }
  });
  ws.on("error", (e) => {
    console.error("WS error:", e.message);
    process.exit(1);
  });
  await new Promise((resolve) => ws.on("open", resolve));
  console.log(`Link:   ws://${HOST}/track\n`);

  const detourStart = Math.floor(samples.length * 0.45);
  const detourEnd = Math.floor(samples.length * 0.65);
  let offset = 0; // 0 = on the centerline, 1 = fully detoured

  for (let i = 0; i < samples.length; i++) {
    const target = !STAY_ON && i >= detourStart && i < detourEnd ? 1 : 0;
    offset = TELEPORT
      ? target
      : offset + Math.max(-1 / RAMP_PINGS, Math.min(1 / RAMP_PINGS, target - offset));

    const noise = () => (Math.random() - 0.5) * 0.00008; // ~±4 m GPS jitter
    const lon = samples[i][0] + offset * DETOUR_LON + noise();
    const lat = samples[i][1] + noise();
    const next = samples[Math.min(i + 1, samples.length - 1)];
    const heading = (turf.bearing(turf.point([lon, lat]), turf.point(next)) + 360) % 360;

    ws.send(
      JSON.stringify({
        deviceId: "simulator",
        lon,
        lat,
        speed: speedMs,
        heading,
        accuracy: 5,
        ts: Date.now(),
      })
    );
    console.log(
      `-> ping ${String(i + 1).padStart(3)}/${samples.length}  ` +
        `${lon.toFixed(5)},${lat.toFixed(5)}${offset > 0.01 ? "  [detour]" : ""}`
    );
    await new Promise((r) => setTimeout(r, PING_MS));
  }

  console.log("\nDrive complete.");
  setTimeout(() => {
    ws.close();
    process.exit(0);
  }, 500);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

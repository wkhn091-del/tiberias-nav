// simulate_profile.js — exercise the gamification system without the app.
//
// Reads a device's profile, and optionally earns points first so you can watch
// the totals and rank move. Points come from two sources (Phase 22):
//   * driving  — 1 point per whole accumulated kilometre
//   * reporting — 10 points per accepted traffic report
//
// This script fakes a drive by walking a straight line of telemetry pings, so
// the server's own haversine step logic banks the distance exactly as it would
// for a real driver. Requires MongoDB to be up — with Mongo down the server
// intentionally returns a zeroed profile with persisted:false.
//
// Run from the server/ folder (it uses this folder's node_modules):
//   node simulate_profile.js                     # just read the profile
//   node simulate_profile.js --drive 5           # drive ~5 km, then read
//   node simulate_profile.js --report 3          # file 3 reports, then read
//   node simulate_profile.js --drive 2 --report 1
//   DEVICE_ID=my-phone node simulate_profile.js  # target a specific device
//   SERVER_HOST=192.168.1.42:3000 node simulate_profile.js

const WebSocket = require("ws");

const HOST = process.env.SERVER_HOST || "localhost:3000";
const DEVICE_ID = process.env.DEVICE_ID || "sim-profile-1";
const args = process.argv.slice(2);

function numFlag(name, fallback) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}

const driveKm = numFlag("--drive", 0);
const reportCount = numFlag("--report", 0);
// Report cooldown is 5 s per connection server-side, so space them out.
const REPORT_GAP_MS = Number(process.env.REPORT_GAP_MS || 5500);
const PING_GAP_MS = Number(process.env.PING_GAP_MS || 120);
const REPORT_TYPES = ["Police", "Accident", "Hazard", "Traffic Jam"];

// Walk north from Tiberias centre. 0.05 km per ping keeps every step well under
// the server's MAX_STEP_KM sanity cap and its teleport guard.
const START_LON = 35.5395;
const START_LAT = 32.79;
const STEP_KM = 0.05;
const KM_PER_DEG_LAT = 111.32;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ws = new WebSocket(`ws://${HOST}/track`);

ws.on("open", async () => {
  console.log(`connected to ws://${HOST}/track as "${DEVICE_ID}"`);

  if (driveKm > 0) {
    const steps = Math.ceil(driveKm / STEP_KM);
    console.log(`\ndriving ~${driveKm} km (${steps} pings)…`);
    for (let i = 0; i <= steps; i++) {
      ws.send(
        JSON.stringify({
          deviceId: DEVICE_ID,
          lon: START_LON,
          lat: START_LAT + (i * STEP_KM) / KM_PER_DEG_LAT,
          speed: 15,
          heading: 0,
          accuracy: 5,
          ts: Date.now(),
        })
      );
      await sleep(PING_GAP_MS);
    }
    console.log(`  sent ${steps + 1} pings`);
    await sleep(800); // let the last distance flush land
  }

  for (let i = 0; i < reportCount; i++) {
    const reportType = REPORT_TYPES[i % REPORT_TYPES.length];
    console.log(`\nfiling report ${i + 1}/${reportCount}: ${reportType}`);
    ws.send(
      JSON.stringify({
        type: "traffic_report",
        deviceId: DEVICE_ID,
        reportType,
        location: [START_LON, START_LAT],
      })
    );
    if (i < reportCount - 1) await sleep(REPORT_GAP_MS);
  }
  if (reportCount > 0) await sleep(800);

  console.log("\nrequesting profile…");
  ws.send(JSON.stringify({ type: "get_profile", deviceId: DEVICE_ID }));
});

ws.on("message", (raw) => {
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  if (m.type === "profile_results") {
    console.log("\n─── profile ───────────────────");
    console.log(`  device    ${DEVICE_ID}`);
    console.log(`  rank      ${m.rank}`);
    console.log(`  points    ${m.points}`);
    console.log(`  distance  ${m.totalDistanceKm} km`);
    if (!m.persisted) {
      console.log("  note      not persisted — MongoDB is down, so this is a zeroed fallback");
    }
    console.log("───────────────────────────────");
    ws.close();
    process.exit(0);
  }
  if (m.type === "report_ack") console.log(`  ack ${m.id}`);
  if (m.type === "report_error") console.log(`  report rejected: ${m.message}`);
  if (m.type === "rejected") console.log(`  ping rejected: ${m.reason}`);
});

ws.on("error", (e) => {
  console.error(`socket error: ${e.message}`);
  console.error(`is the server running on ${HOST}?`);
  process.exit(1);
});

setTimeout(() => {
  console.error("timed out waiting for profile_results");
  process.exit(1);
}, Number(process.env.TIMEOUT_MS || 120000));

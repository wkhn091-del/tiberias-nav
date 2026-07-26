// simulate_jam.js — drive slowly enough to trigger automatic congestion
// detection (Phase 23), without leaving your desk.
//
// The server watches each connection's telemetry: 3 consecutive pings that are
// MOVING but under 15 km/h auto-generate a "Traffic Jam" report, which then
// flows into the same broadcast + V2X proximity pipeline as a manual report.
//
// Run from the server/ folder:
//   node simulate_jam.js                 # crawl at 8 km/h -> expect one auto-jam
//   node simulate_jam.js --kmh 40        # normal speed -> expect NO report
//   node simulate_jam.js --kmh 8 --pings 20   # sustained: still only ONE report (dedup)
//   node simulate_jam.js --watch         # just listen for others' reports
//   SERVER_HOST=myapp.up.railway.app node simulate_jam.js
//
// Watch the SERVER log for "[auto-jam] ..." — that's the detector firing.

const WebSocket = require("ws");

const HOST = process.env.SERVER_HOST || "localhost:3000";
const DEVICE_ID = process.env.DEVICE_ID || "sim-jam-1";
const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(n);
  if (i === -1) return d;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) ? v : d;
};

const KMH = flag("--kmh", 8);
const PINGS = flag("--pings", 6);
const GAP_MS = flag("--gap", 2000);
const WATCH_ONLY = args.includes("--watch");

// Crawl north from Tiberias centre at the requested speed, so the positions are
// consistent with the speed field (the server trusts GPS speed, but keeping
// them coherent also exercises the distance/gamification path realistically).
const START_LON = 35.5395;
const START_LAT = 32.79;
const KM_PER_DEG_LAT = 111.32;
const speedMs = KMH / 3.6;
const stepKm = (speedMs * (GAP_MS / 1000)) / 1000;

const secure = /^(wss|https):\/\//i.test(HOST) || !/:\d+$/.test(HOST);
const bare = HOST.replace(/^[a-z]+:\/\//i, "");
const url = `${secure ? "wss" : "ws"}://${bare}/track`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ws = new WebSocket(url);

ws.on("open", async () => {
  console.log(`connected to ${url} as "${DEVICE_ID}"`);
  if (WATCH_ONLY) {
    console.log("watching for reports… (ctrl-c to stop)");
    return;
  }
  console.log(
    `crawling at ${KMH} km/h for ${PINGS} pings (${GAP_MS}ms apart)\n` +
      `threshold is 15 km/h for 3 consecutive pings — ${
        KMH < 15 && KMH > 1.8 ? "EXPECT an auto-jam" : "expect NO auto-jam"
      }\n`
  );
  for (let i = 0; i < PINGS; i++) {
    ws.send(
      JSON.stringify({
        deviceId: DEVICE_ID,
        lon: START_LON,
        lat: START_LAT + (i * stepKm) / KM_PER_DEG_LAT,
        speed: speedMs, // m/s — what the detector reads
        heading: 0,
        accuracy: 5,
        ts: Date.now(),
      })
    );
    process.stdout.write(`  ping ${i + 1}/${PINGS} @ ${KMH} km/h\r`);
    await sleep(GAP_MS);
  }
  console.log("\n\ndone sending. Waiting a moment for broadcasts…");
  await sleep(2500);
  console.log("(check the SERVER log for a [auto-jam] line)");
  ws.close();
  process.exit(0);
});

ws.on("message", (raw) => {
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  if (m.type === "traffic_report") {
    const who = m.deviceId === "system" ? "AUTO-GENERATED" : `from ${m.deviceId || "anon"}`;
    console.log(`\n  << traffic_report [${m.reportType}] ${who} @ ${m.location}`);
  }
  if (m.type === "proximity_alert") {
    console.log(`\n  << proximity_alert [${m.reportType}] ${Math.round(m.distanceMeters)}m ahead`);
  }
  if (m.type === "rejected") console.log(`\n  << ping rejected: ${m.reason}`);
});

ws.on("error", (e) => {
  console.error(`socket error: ${e.message}`);
  console.error(`is the server running on ${HOST}?`);
  process.exit(1);
});

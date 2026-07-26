// simulate_traffic.js — spawn N virtual drivers so the Social Live Map has
// someone to show. Each opens its own WebSocket and drives a slow loop around
// Tiberias, so your phone (or another sim) sees them as nearby_drivers.
//
// Run from the server/ folder:
//   node simulate_traffic.js                # 5 drivers circling
//   node simulate_traffic.js --drivers 12   # busier
//   node simulate_traffic.js --watch        # add a listener that prints frames
//   SERVER_HOST=myapp.up.railway.app node simulate_traffic.js
//
// Ctrl-C to stop. Drivers vanish from everyone's map ~20s later (server TTL).

const WebSocket = require("ws");

const HOST = process.env.SERVER_HOST || "localhost:3000";
const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(n);
  if (i === -1) return d;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) ? v : d;
};

const COUNT = flag("--drivers", 5);
const GAP_MS = flag("--gap", 2000);
const WATCH = args.includes("--watch");

const CENTER_LON = 35.5395;
const CENTER_LAT = 32.79;
const KM_PER_DEG_LAT = 111.32;
// Spread them over ~2km so they're all inside each other's 5km radius.
const RADIUS_KM = 2;

const secure = /^(wss|https):\/\//i.test(HOST) || !/:\d+$/.test(HOST);
const bare = HOST.replace(/^[a-z]+:\/\//i, "");
const url = `${secure ? "wss" : "ws"}://${bare}/track`;

function spawnDriver(i) {
  const id = `sim-drv-${i}`;
  const ws = new WebSocket(url);
  // Each driver circles at its own phase and speed, so headings differ and the
  // rotated chevrons visibly point in different directions on the map.
  let angle = (i / COUNT) * Math.PI * 2;
  const angularSpeed = 0.06 + (i % 3) * 0.02;

  ws.on("open", () => {
    console.log(`  ${id} connected`);
    const tick = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return clearInterval(tick);
      angle += angularSpeed;
      const dLat = (Math.sin(angle) * RADIUS_KM) / KM_PER_DEG_LAT;
      const dLon =
        (Math.cos(angle) * RADIUS_KM) /
        (KM_PER_DEG_LAT * Math.cos((CENTER_LAT * Math.PI) / 180));
      // Tangent to the circle = the direction of travel, in compass degrees.
      const headingDeg = ((-angle * 180) / Math.PI + 90 + 360 * 4) % 360;
      ws.send(
        JSON.stringify({
          deviceId: id,
          lon: CENTER_LON + dLon,
          lat: CENTER_LAT + dLat,
          speed: 12 + (i % 5) * 4, // m/s — above the congestion threshold
          heading: headingDeg,
          accuracy: 5,
          ts: Date.now(),
        })
      );
    }, GAP_MS);
    ws.on("close", () => clearInterval(tick));
  });

  ws.on("error", (e) => console.error(`  ${id} error: ${e.message}`));
  return ws;
}

console.log(`spawning ${COUNT} virtual drivers -> ${url}\n`);
const sockets = [];
for (let i = 0; i < COUNT; i++) sockets.push(spawnDriver(i));

if (WATCH) {
  const obs = new WebSocket(url);
  obs.on("open", () => {
    console.log("\n  observer connected (pinging from the centre)");
    setInterval(() => {
      if (obs.readyState === WebSocket.OPEN) {
        obs.send(
          JSON.stringify({
            deviceId: "sim-observer",
            lon: CENTER_LON,
            lat: CENTER_LAT,
            speed: 0,
            heading: 0,
            accuracy: 5,
            ts: Date.now(),
          })
        );
      }
    }, GAP_MS);
  });
  obs.on("message", (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.type === "nearby_drivers") {
      console.log(`\n  << nearby_drivers: ${m.drivers.length} driver(s)`);
      for (const d of m.drivers.slice(0, 8)) {
        console.log(
          `       ${d.deviceId.padEnd(12)} ${String(d.distanceM).padStart(5)}m  ` +
            `hdg ${String(Math.round(d.heading)).padStart(3)}°  [${d.rank}]`
        );
      }
    }
  });
  sockets.push(obs);
}

process.on("SIGINT", () => {
  console.log("\nclosing…");
  for (const s of sockets) {
    try {
      s.close();
    } catch {}
  }
  process.exit(0);
});

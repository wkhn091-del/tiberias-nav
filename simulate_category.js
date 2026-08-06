// simulate_category.js — fire a category_search at the server and print results.
//
// Lets you test the Overpass-backed category endpoint without the app. Hits the
// REAL public Overpass by default (be patient — it's a shared instance), or
// point OVERPASS_URL at a stub. Run from server/ (uses this folder's node_modules):
//
//   node simulate_category.js                 # food near Tiberias center
//   node simulate_category.js gas             # gas | food | emergency
//   node simulate_category.js emergency 32.79 35.5395
//   SERVER_HOST=192.168.1.42:3000 node simulate_category.js food

const WebSocket = require("ws");

const HOST = process.env.SERVER_HOST || "localhost:3000";
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const category = args[0] || "food"; // food | gas | emergency
const lat = Number(args[1] ?? 32.79);
const lon = Number(args[2] ?? 35.5395);
const WINDOW_MS = Number(process.env.WINDOW_MS || 25000); // Overpass can be slow

const ws = new WebSocket(`ws://${HOST}/track`);

ws.on("open", () => {
  console.log(`connected to ws://${HOST}/track`);
  const frame = { type: "category_search", category, lat, lon };
  console.log("sending:", JSON.stringify(frame));
  ws.send(JSON.stringify(frame));
  setTimeout(() => {
    console.log("timeout — no results in window; is the server up and Overpass reachable?");
    ws.close();
    process.exit(1);
  }, WINDOW_MS);
});

ws.on("message", (raw) => {
  try {
    const m = JSON.parse(String(raw));
    if (m.type !== "category_results") return; // ignore status frames etc.
    if (m.error) {
      console.log(`✗ ${m.category}: ${m.error}`);
    } else {
      console.log(`✓ ${m.category}: ${m.items.length} POIs`);
      m.items.forEach((it, i) =>
        console.log(`  ${i + 1}. ${it.name}${it.detail ? ` (${it.detail})` : ""} — ${it.distanceM} m`)
      );
    }
    ws.close();
    process.exit(0);
  } catch {
    /* ignore non-JSON */
  }
});

ws.on("error", (err) => {
  console.error(`connection failed (${err.message}) — is the server running on ${HOST}?`);
  process.exit(1);
});

// simulate_report.js — fire a traffic report at the server and watch replies.
//
// Stands in for a second driver: connects to ws://HOST/track, sends one
// traffic_report, prints every frame it receives for a few seconds, exits.
// Run the app on your phone at the same time and the report pops up there
// ("דיווח חדש בקרבת מקום"). Or run TWO copies of this script in two terminals
// with --listen on one of them to see the broadcast land.
//
// Run from the server/ folder (it uses this folder's node_modules):
//   node simulate_report.js                        # sends a Police report at Tiberias center
//   node simulate_report.js Hazard                 # choose the type
//   node simulate_report.js "Traffic Jam" 35.53 32.78   # type + lon + lat
//   node simulate_report.js --listen               # send nothing; just print broadcasts
//   SERVER_HOST=192.168.1.42:3000 node simulate_report.js

const WebSocket = require("ws");

const HOST = process.env.SERVER_HOST || "localhost:3000";
const args = process.argv.slice(2);
const listenOnly = args.includes("--listen");
const positional = args.filter((a) => !a.startsWith("--"));
const reportType = positional[0] || "Police"; // Police | Accident | Hazard | Traffic Jam
const lon = Number(positional[1] ?? 35.5395);
const lat = Number(positional[2] ?? 32.79);
const WINDOW_MS = Number(process.env.WINDOW_MS || 4000);

const ws = new WebSocket(`ws://${HOST}/track`);

ws.on("open", () => {
  console.log(`connected to ws://${HOST}/track`);
  if (listenOnly) {
    console.log(`listening for broadcasts for ${WINDOW_MS} ms…`);
  } else {
    const frame = {
      type: "traffic_report",
      deviceId: `sim-${Math.random().toString(36).slice(2, 8)}`,
      reportType,
      location: [lon, lat],
    };
    console.log("sending:", JSON.stringify(frame));
    ws.send(JSON.stringify(frame));
  }
  setTimeout(() => {
    console.log("done.");
    ws.close();
    process.exit(0);
  }, WINDOW_MS);
});

ws.on("message", (raw) => {
  try {
    const m = JSON.parse(String(raw));
    if (m.type === "report_ack") console.log(`✓ server ack — report id ${m.id}`);
    else if (m.type === "report_error") console.log(`✗ report rejected: ${m.message}`);
    else if (m.type === "traffic_report")
      console.log(`⇦ broadcast from ${m.deviceId || "anon"}: ${m.reportType} @ ${m.location.join(",")}`);
    else console.log("frame:", JSON.stringify(m));
  } catch {
    console.log("non-JSON frame:", String(raw));
  }
});

ws.on("error", (err) => {
  console.error(`connection failed (${err.message}) — is the server running on ${HOST}?`);
  process.exit(1);
});

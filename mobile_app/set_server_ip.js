// set_server_ip.js — write this machine's LAN IP into the Expo app's .env so
// MapScreen resolves the telemetry server without hand-editing code.
//
// Copy into the Expo project root (next to package.json) and run BEFORE
// starting the dev server:
//   node set_server_ip.js          # default port 3000
//   node set_server_ip.js 5000     # custom server port
// Then restart Metro (env values are read when the bundler starts).
//
// Note: dev builds can already auto-detect the host — MapScreen falls back to
// the Metro bundler host from expo-constants. This script matters when the
// API server runs on a different machine than Metro, or when the wrong
// interface wins (VPNs, virtual adapters, multiple NICs).

const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = process.argv[2] || "3000";
const KEY = "EXPO_PUBLIC_SERVER_HOST";

function lanIPv4Candidates() {
  const found = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) found.push({ name, address: a.address });
    }
  }
  // prefer classic home/office LAN ranges over VPN/virtual adapters
  const rank = (ip) =>
    ip.startsWith("192.168.") ? 0
    : ip.startsWith("10.") ? 1
    : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2
    : 3;
  return found.sort((a, b) => rank(a.address) - rank(b.address));
}

const candidates = lanIPv4Candidates();
if (candidates.length === 0) {
  console.error("No external IPv4 interface found — are you connected to a network?");
  process.exit(1);
}

const { name, address } = candidates[0];
const line = `${KEY}=${address}:${PORT}`;
const envPath = path.join(process.cwd(), ".env");

const kept = fs.existsSync(envPath)
  ? fs.readFileSync(envPath, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith(`${KEY}=`))
  : [];
fs.writeFileSync(envPath, [...kept, line].join("\n") + "\n");

console.log(`Detected ${address} (${name})`);
if (candidates.length > 1) {
  console.log("Other candidates:", candidates.slice(1).map((c) => `${c.address} (${c.name})`).join(", "));
}
console.log(`Wrote "${line}" -> ${envPath}`);
console.log("Restart the Expo dev server so the new value is picked up.");

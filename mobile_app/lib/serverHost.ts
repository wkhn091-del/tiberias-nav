// lib/serverHost.ts
//
// Resolve the dev PC's address at runtime so a physical device connects to the
// Node server with no hardcoding and no manual typing — even when the router
// hands out a new LAN IP.
//
// HOW IT WORKS (and why the automatic layer is enough for local dev):
// When the JS bundle is served by Metro (`expo start` + a dev/dev-client
// build), Expo injects the bundler's host — your PC's current LAN IP — into
// Constants. We read it and reuse it for the API server, assuming the server
// runs on the same PC as Metro (it does, in this project). New IP tomorrow?
// Metro reports the new one; nothing to change.
//
// Resolution order (first hit wins):
//   1. EXPO_PUBLIC_SERVER_HOST — explicit override, baked at build time from
//      .env (local) or eas.json "env" (EAS). Use this for standalone APKs,
//      which have no Metro to auto-detect.
//   2. Metro bundler host from expo-constants — the automatic local-dev path.
//   3. localhost — last resort (correct only on an emulator w/ adb reverse).
//
// getServerHost() returns "host:port"; helpers derive http:// and ws:// URLs.

import Constants from "expo-constants";

// THE single port declaration in the mobile app. lib/config.ts re-exports this
// as SERVER_PORT and everything else imports it from there, so the value exists
// once rather than in four files that have to be kept in step by hand.
//
// MUST match the server's default (server.js: `process.env.PORT || 3000`).
// This was 4000, then 8080, and each move silently broke zero-config local dev
// the same way: auto-detection still found the right PC, then dialled a port
// nothing was listening on. Two ends, one number — change both together.
export const DEFAULT_PORT = 3000;

/**
 * Pull the Metro bundler's hostname out of whichever Constants field carries
 * it in this runtime. Different Expo setups populate different fields, so we
 * check the known carriers in order. Returns just the host (no port/scheme),
 * or null when not served by Metro (e.g. a standalone build).
 *
 * Exported as a pure function of its input so it can be unit-tested without a
 * device — see the __tests__ block reasoning in the PR.
 */
export function extractMetroHost(sources: (string | undefined | null)[]): string | null {
  for (const raw of sources) {
    if (!raw) continue;
    // Values look like "10.0.0.5:8081", "192.168.1.9:8081", "exp://10.0.0.5:8081",
    // or occasionally a bare host. Strip any scheme, then take the host part.
    const noScheme = raw.replace(/^[a-z]+:\/\//i, "");
    const host = noScheme.split("/")[0].split(":")[0].trim();
    if (!host) continue;
    // A tunnel/LAN name we can't reach directly is useless for a raw socket;
    // "localhost"/127.0.0.1 from Metro means the emulator case — skip so we
    // fall through to the explicit localhost default only if nothing else hits.
    if (host === "localhost" || host === "127.0.0.1") continue;
    return host;
  }
  return null;
}

/** Gather every Constants field that can carry the Metro host, newest API first. */
function metroHostFromConstants(): string | null {
  const anyConstants = Constants as unknown as {
    expoConfig?: { hostUri?: string } | null;
    expoGoConfig?: { debuggerHost?: string; hostUri?: string } | null;
    manifest?: { hostUri?: string; debuggerHost?: string } | null;
    manifest2?: { extra?: { expoGo?: { debuggerHost?: string } } } | null;
  };
  return extractMetroHost([
    anyConstants.expoConfig?.hostUri,
    anyConstants.expoGoConfig?.debuggerHost,
    anyConstants.expoGoConfig?.hostUri,
    anyConstants.manifest?.hostUri,
    anyConstants.manifest?.debuggerHost,
    anyConstants.manifest2?.extra?.expoGo?.debuggerHost,
  ]);
}

/**
 * The resolved "host:port" for the backend. Layer order documented above.
 * @param port backend port (default DEFAULT_PORT, matching the server)
 */
export function getServerHost(port: number = DEFAULT_PORT): string {
  const override = process.env.EXPO_PUBLIC_SERVER_HOST;
  if (override) {
    const trimmed = override.trim().replace(/\/+$/, "");
    // Already fully qualified — a scheme ("wss://api.example.com") or an
    // explicit port ("10.0.0.5:4000") — so use it verbatim.
    if (/^[a-z]+:\/\//i.test(trimmed) || trimmed.includes(":")) return trimmed;
    // A public hostname is a DEPLOYED backend, reachable on the default TLS
    // port. Appending the dev port would send the app to a closed port and
    // nothing would connect — this is the usual first-deploy failure. A bare
    // LAN IPv4 has dots too, so it's excluded and still gets the dev port.
    if (trimmed.includes(".") && !/^\d+\.\d+\.\d+\.\d+$/.test(trimmed)) return trimmed;
    return `${trimmed}:${port}`;
  }

  const metroHost = metroHostFromConstants();
  if (metroHost) return `${metroHost}:${port}`;

  return `localhost:${port}`;
}

/** true when we're relying on the localhost fallback — handy for a HUD warning. */
export function isUsingLocalhostFallback(port: number = DEFAULT_PORT): boolean {
  return getServerHost(port) === `localhost:${port}`;
}

/**
 * Does this host need TLS (wss:// + https://)?
 *
 * Cloud platforms terminate TLS at their edge and expose only 443, so a
 * deployed backend MUST be reached over the secure schemes — plain ws:// is
 * refused, and Android 9+ blocks cleartext by default regardless. Local dev
 * targets a LAN IP with an explicit port and stays cleartext.
 *
 * Rule: an explicit scheme wins; otherwise "has no :port" means deployed.
 */
export function isSecureHost(host: string): boolean {
  if (/^(wss|https):\/\//i.test(host)) return true;
  if (/^(ws|http):\/\//i.test(host)) return false;
  return !/:\d+$/.test(host);
}

/** Strip any scheme and trailing slashes, leaving "host" or "host:port". */
export function bareHost(host: string): string {
  return host.replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "");
}

/**
 * Normalise whatever the user typed into the in-app server-host box. Mirrors
 * getServerHost's rules so the runtime override behaves like the build-time one.
 */
export function normalizeHostInput(input: string, port: number = DEFAULT_PORT): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) return trimmed;
  if (/^[a-z]+:\/\//i.test(trimmed) || trimmed.includes(":")) return trimmed;
  if (trimmed.includes(".") && !/^\d+\.\d+\.\d+\.\d+$/.test(trimmed)) return trimmed;
  return `${trimmed}:${port}`;
}

export const httpBase = (host: string) =>
  `${isSecureHost(host) ? "https" : "http"}://${bareHost(host)}`;
export const wsBase = (host: string) =>
  `${isSecureHost(host) ? "wss" : "ws"}://${bareHost(host)}`;

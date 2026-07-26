// lib/config.ts — one place to point the app at a backend.
//
// GOAL: `npx expo start` at home talks to the PC on the LAN; a standalone APK
// on the road talks to the cloud; nobody edits code between the two.
//
// ---------------------------------------------------------------------------
// WHAT TO EDIT
//
//   PROD_URL      your deployed backend. Used by any build Metro isn't serving.
//   LOCAL_URL     normally leave EMPTY. Auto-detection finds your PC by itself;
//                 only fill this in if you need to pin a specific address.
//
// Nothing else in the app should hardcode a host, a port or a scheme.
// ---------------------------------------------------------------------------

import Constants from "expo-constants";
import {
  DEFAULT_PORT,
  bareHost,
  getServerHost,
  httpBase,
  isSecureHost,
  wsBase,
} from "./serverHost";

/** Paste your deployed URL here. Scheme included; no trailing slash. */
export const PROD_URL = "https://your-cloud-app.up.railway.app";

/**
 * Optional manual pin for local dev, e.g. "http://192.168.1.42:3000".
 *
 * Deliberately EMPTY by default. Auto-detection (below) reads the address your
 * PC is already serving Metro from, so it follows the router when DHCP hands
 * you a new lease. Hardcoding an IP here trades one manual edit (a boolean) for
 * a different manual edit (an IP) — and the IP one bites more often, because it
 * changes without you doing anything.
 */
export const LOCAL_URL = "";

/**
 * The backend port. THE single declaration in the mobile app — serverHost's
 * DEFAULT_PORT — re-exported so call sites import one name.
 *
 * It must match `process.env.PORT || <n>` in server/server.js. That pairing has
 * broken before: the server moved 4000 -> 8080 while the app kept dialling
 * 4000, so auto-detection found the right PC and then knocked on a door nobody
 * was behind. If you change one end, change the other.
 */
export const SERVER_PORT = DEFAULT_PORT;

/**
 * Is this bundle being served by the Metro dev server?
 *
 * WHY NOT `__DEV__`, which is the obvious choice and was the one requested:
 *
 * `__DEV__` answers "was this bundle built in dev mode", and that is not the
 * same question. It is TRUE in Expo Go and ALSO true in a development build
 * (`eas build --profile development`) — an APK you install and run on
 * cellular, far from your LAN. Keying the URL off `__DEV__` sends exactly that
 * build to `192.168.x.x` and it fails with no obvious cause.
 *
 * The thing that actually differs between "expo start" and a standalone APK is
 * whether Metro is on the other end, and expo-constants tells us that directly.
 * Correct in all four cases: Expo Go, dev build, preview build, production.
 *
 * `__DEV__` is still consulted, but only as a confirming signal — a bundle
 * built for release is never talking to Metro, whatever Constants claims.
 */
export function isServedByMetro(): boolean {
  // Read through globalThis rather than referencing __DEV__ directly: React
  // Native declares it ambiently, but this module should still compile in any
  // toolchain that doesn't (a bare tsc, a test runner, a web build) rather than
  // failing on an undeclared name.
  const g = globalThis as { __DEV__?: boolean };
  const dev = typeof g.__DEV__ === "boolean" ? g.__DEV__ : false;
  if (!dev) return false;
  const c = Constants as unknown as {
    expoConfig?: { hostUri?: string } | null;
    expoGoConfig?: { debuggerHost?: string; hostUri?: string } | null;
    manifest?: { hostUri?: string; debuggerHost?: string } | null;
  };
  return !!(
    c.expoConfig?.hostUri ||
    c.expoGoConfig?.debuggerHost ||
    c.expoGoConfig?.hostUri ||
    c.manifest?.hostUri ||
    c.manifest?.debuggerHost
  );
}

/**
 * Resolved backend as "host[:port]" — scheme-less, because the scheme is
 * derived from it (a cloud host implies TLS; a LAN host with a port doesn't).
 *
 * Order, first hit wins:
 *   1. LOCAL_URL          you pinned one by hand
 *   2. EXPO_PUBLIC_SERVER_HOST  build-time env; how EAS profiles inject a URL
 *   3. Metro's host       local dev, found automatically
 *   4. PROD_URL           standalone build with no Metro — the road case
 *   5. localhost          last resort (emulator with adb reverse)
 */
export function resolveHost(): string {
  if (LOCAL_URL.trim()) return bareHost(LOCAL_URL.trim());
  if (process.env.EXPO_PUBLIC_SERVER_HOST) return getServerHost(SERVER_PORT);
  if (isServedByMetro()) return getServerHost(SERVER_PORT);
  if (PROD_URL.trim()) return bareHost(PROD_URL.trim());
  return getServerHost(SERVER_PORT);
}

/** "host[:port]" for the resolved backend. */
export const SERVER_HOST = resolveHost();

/** e.g. "http://192.168.1.42:3000" or "https://your-cloud-app.up.railway.app" */
export const BASE_URL = httpBase(SERVER_HOST);

/** e.g. "ws://192.168.1.42:3000" or "wss://your-cloud-app.up.railway.app" */
export const WS_URL = wsBase(SERVER_HOST);

/** The telemetry socket the map connects to. */
export const TRACK_WS_URL = `${WS_URL}/track`;

/** True when the resolved backend needs TLS — cloud hosts do, LAN ones don't. */
export const IS_SECURE = isSecureHost(SERVER_HOST);

/**
 * True when we fell through to PROD_URL, i.e. this build is pointed at the
 * cloud. Useful for a HUD badge so it's obvious on-device which end you're on.
 */
export const IS_CLOUD_TARGET =
  !LOCAL_URL.trim() && !process.env.EXPO_PUBLIC_SERVER_HOST && !isServedByMetro();

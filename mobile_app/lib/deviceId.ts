// lib/deviceId.ts
//
// A STABLE per-install identity for this device.
//
// WHY THIS EXISTS
// The server keys everything durable on deviceId: gamification profiles
// (points / totalDistanceKm / rank), search history, and the live-map registry.
// Before this module the id was `poc-${Math.random()}` regenerated on every JS
// launch, which meant a driver silently became a brand-new person every time
// they reopened the app — points reset to zero, rank fell back to "New Driver",
// and their recent searches vanished. Persisting the id is what makes all of
// those features actually work across sessions.
//
// WHY AsyncStorage AND NOT SecureStore
// This is an identifier, not a secret. AsyncStorage is a plain key-value store:
// no keychain/keystore round-trip, no biometric or lock-screen edge cases, and
// no risk of the Android keystore being invalidated (which happens when the
// device's lock screen is changed and would silently wipe the id — exactly the
// failure we're fixing). If this ever carries an auth token instead, move THAT
// token to expo-secure-store and leave this id here.
//
// LIFETIME
// Survives app restarts and OTA updates. Cleared by an uninstall or by the user
// clearing app data — both of which legitimately mean "a fresh install", so
// starting a new profile there is the correct behaviour.

import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "tiberias_nav.deviceId.v1";

/**
 * Generate a fresh id. Deliberately not a real UUID: pulling in a uuid package
 * (and a crypto polyfill for React Native's missing getRandomValues) is a lot
 * of dependency for a value that only needs to be unique across our own users.
 * Time prefix + two random blocks gives ~64 bits of entropy on top of a
 * millisecond timestamp, which is far beyond what collision risk requires here.
 */
export function generateDeviceId(): string {
  const block = () => Math.random().toString(36).slice(2, 10);
  return `drv-${Date.now().toString(36)}-${block()}${block()}`;
}

/**
 * Read the stored id, creating and persisting one on first launch.
 *
 * NEVER throws and NEVER hangs: if storage is unavailable (a corrupt store, a
 * device with no free space, a web target without localStorage) this falls back
 * to a session-only id so the app still runs. That degrades gamification back
 * to the old per-launch behaviour instead of blocking boot on a blank screen.
 *
 * @returns the id, plus whether it came from disk — the caller can surface
 *          "stats won't persist" if `persisted` is false.
 */
export async function loadOrCreateDeviceId(): Promise<{
  deviceId: string;
  persisted: boolean;
  created: boolean;
}> {
  try {
    const existing = await AsyncStorage.getItem(STORAGE_KEY);
    if (existing && existing.trim()) {
      return { deviceId: existing.trim(), persisted: true, created: false };
    }
    const fresh = generateDeviceId();
    await AsyncStorage.setItem(STORAGE_KEY, fresh);
    return { deviceId: fresh, persisted: true, created: true };
  } catch (e) {
    // Storage is broken or unavailable. Keep the app usable.
    console.warn(
      "[deviceId] storage unavailable — using a session-only id, stats will not persist:",
      e instanceof Error ? e.message : e
    );
    return { deviceId: generateDeviceId(), persisted: false, created: true };
  }
}

/**
 * Wipe the stored id. Not wired to any UI yet — here so a future "reset my
 * profile" / "sign out" action has a single correct place to call, rather than
 * reaching into AsyncStorage with a duplicated key string.
 */
export async function clearDeviceId(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing meaningful to do — the next load just generates a new id */
  }
}

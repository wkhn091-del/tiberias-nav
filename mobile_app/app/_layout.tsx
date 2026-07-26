// app/_layout.tsx — root navigator. A single full-bleed screen with no header,
// so the map fills the display.
import { Stack } from "expo-router";

export default function RootLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}

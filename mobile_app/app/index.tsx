// app/index.tsx — the "/" route. expo-router renders this as the home screen.
// The map lives in components/MapScreen.tsx; this file just mounts it.
import MapScreen from "../components/MapScreen";

export default function Home() {
  return <MapScreen />;
}

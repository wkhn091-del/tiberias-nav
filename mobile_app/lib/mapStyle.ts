// lib/mapStyle.ts
//
// Runtime style interceptor.
//
// MapLibre's `mapStyle` prop accepts either a URL or a full style object. We
// fetch the upstream style JSON, rewrite it, and hand back the object — which
// lets us change things the hosted style doesn't expose: label language, 3D
// building extrusions, and the night palette.
//
// Everything here is defensive. These are third-party styles that can change
// shape without notice, so every transform tolerates missing layers, missing
// sources and unexpected property types, and the loader falls back to the plain
// URL if anything goes wrong. A worse-looking map is acceptable; a blank one is
// not.

export type StyleJson = Record<string, any>;

// ---------------------------------------------------------------- palette ---
// Deep navy rather than black: pure black kills the sense of depth once
// buildings are extruded, and makes the route ribbon glare at night.
const NIGHT = {
  background: "#070B14",
  water: "#050A18",
  // Extruded buildings. Walls sit close to the background so the city reads as
  // a silhouette; roofs are lifted enough to catch the eye at a 78° pitch.
  buildingWall: "#151C2E",
  buildingRoof: "#26314C",
  // Motorways/trunks get a cool luminescence, like lit carriageways from above.
  roadMajor: "#3E5C8A",
  roadMinor: "#1B2438",
};

const DAY = {
  buildingWall: "#D8DEE9",
  buildingRoof: "#EDF1F7",
};

// ------------------------------------------------------------ localization ---
/**
 * Force Hebrew labels wherever OSM carries them.
 *
 * Applied to every symbol layer that actually renders text — icon-only layers
 * are left alone, since giving them a text-field would make them start drawing
 * labels that the style never intended.
 *
 * `name` is the fallback rather than `name:en` deliberately: in Israeli OSM the
 * untagged `name` is usually already Hebrew, so falling back to it keeps far
 * more labels in Hebrew than falling back to English would.
 */
export const HEBREW_TEXT_FIELD = [
  "coalesce",
  ["get", "name:he"],
  ["get", "name:hebrew"],
  ["get", "name"],
];

export function localizeToHebrew(style: StyleJson): number {
  let changed = 0;
  for (const layer of style.layers ?? []) {
    if (layer?.type !== "symbol") continue;
    const layout = layer.layout;
    // No text-field at all = icon-only layer. Leave it be.
    if (!layout || layout["text-field"] === undefined) continue;
    layout["text-field"] = JSON.parse(JSON.stringify(HEBREW_TEXT_FIELD));
    changed++;
  }
  return changed;
}

// ------------------------------------------------------------- 3D buildings ---
/**
 * Find the vector source that carries building geometry.
 *
 * Rather than hardcoding "openmaptiles" (OpenFreeMap) or "carto" (CARTO), we
 * look for an existing layer whose source-layer is a known building layer and
 * reuse ITS source. That survives both providers and any future style swap.
 * If no such layer exists we fall back to the first vector source, since the
 * tiles may still contain buildings even when the style never draws them.
 */
function findBuildingSource(style: StyleJson): { source: string; sourceLayer: string } | null {
  const candidates = ["building", "buildings"];
  for (const layer of style.layers ?? []) {
    const sl = layer?.["source-layer"];
    if (typeof layer?.source === "string" && candidates.includes(sl)) {
      return { source: layer.source, sourceLayer: sl };
    }
  }
  const sources = style.sources ?? {};
  for (const [name, src] of Object.entries<any>(sources)) {
    if (src?.type === "vector") return { source: name, sourceLayer: "building" };
  }
  return null;
}

/**
 * Height expression, in metres.
 *
 * OpenMapTiles exposes `render_height` / `render_min_height` (already resolved
 * from height, building:levels and roof tags). Some styles ship raw `height` /
 * `min_height` instead. When neither is present we derive from storey count at
 * the conventional 3m per level, and only then fall back to a flat default —
 * so a tile set with partial attribution still extrudes something sensible
 * rather than collapsing the whole city to one height.
 */
export const BUILDING_HEIGHT_EXPR = [
  "coalesce",
  ["get", "render_height"],
  ["get", "height"],
  ["*", 3, ["coalesce", ["get", "building:levels"], ["get", "levels"], 3]],
];

export const BUILDING_BASE_EXPR = [
  "coalesce",
  ["get", "render_min_height"],
  ["get", "min_height"],
  0,
];

/**
 * Inject a fill-extrusion layer for buildings.
 *
 * Inserted immediately BEFORE the first symbol layer, so extrusions sit above
 * flat fills but below every label — otherwise street names would be swallowed
 * by the buildings they belong to.
 *
 * Colour is interpolated by height so towers read brighter than low-rise, which
 * is what gives the skyline its depth under the 78° navigation pitch.
 */
export function injectBuildings3D(style: StyleJson, dark: boolean): boolean {
  const found = findBuildingSource(style);
  if (!found) return false;
  if ((style.layers ?? []).some((l: any) => l?.id === "nav-buildings-3d")) return false;

  const wall = dark ? NIGHT.buildingWall : DAY.buildingWall;
  const roof = dark ? NIGHT.buildingRoof : DAY.buildingRoof;

  const layer = {
    id: "nav-buildings-3d",
    type: "fill-extrusion",
    source: found.source,
    "source-layer": found.sourceLayer,
    // Extrusions are expensive and meaningless when zoomed out.
    minzoom: 14,
    filter: ["!=", ["get", "hide_3d"], true],
    paint: {
      // taller = lighter, giving the skyline visible relief
      "fill-extrusion-color": [
        "interpolate",
        ["linear"],
        BUILDING_HEIGHT_EXPR,
        0, wall,
        40, roof,
      ],
      "fill-extrusion-height": BUILDING_HEIGHT_EXPR,
      "fill-extrusion-base": BUILDING_BASE_EXPR,
      // Fade extrusions in across the zoom where they start to matter, so they
      // don't pop into existence in one frame.
      "fill-extrusion-opacity": [
        "interpolate",
        ["linear"],
        ["zoom"],
        14, 0,
        15.5, dark ? 0.78 : 0.7,
      ],
      "fill-extrusion-vertical-gradient": true,
    },
  };

  const layers = style.layers ?? (style.layers = []);
  const firstSymbol = layers.findIndex((l: any) => l?.type === "symbol");
  if (firstSymbol === -1) layers.push(layer);
  else layers.splice(firstSymbol, 0, layer);
  return true;
}

// ------------------------------------------------------------ night palette ---
const MAJOR_ROAD_HINTS = ["motorway", "trunk", "primary"];
const MINOR_ROAD_HINTS = ["secondary", "tertiary", "street", "minor", "service"];

/**
 * Deepen the basemap and give major roads a cool glow.
 *
 * Only simple string colours are replaced. Where a style uses a data-driven or
 * interpolated colour expression we leave it untouched — rewriting an
 * expression we didn't author is how you end up with an invisible map.
 */
export function applyNightPalette(style: StyleJson): number {
  let touched = 0;
  for (const layer of style.layers ?? []) {
    const paint = layer?.paint;
    const id = String(layer?.id ?? "").toLowerCase();

    if (layer?.type === "background" && paint) {
      paint["background-color"] = NIGHT.background;
      touched++;
      continue;
    }

    // water bodies, by source-layer or id
    const sl = String(layer?.["source-layer"] ?? "").toLowerCase();
    if ((sl === "water" || id.includes("water")) && paint) {
      if (typeof paint["fill-color"] === "string") {
        paint["fill-color"] = NIGHT.water;
        touched++;
      }
      continue;
    }

    if (layer?.type === "line" && paint && typeof paint["line-color"] === "string") {
      if (MAJOR_ROAD_HINTS.some((h) => id.includes(h))) {
        paint["line-color"] = NIGHT.roadMajor;
        touched++;
      } else if (MINOR_ROAD_HINTS.some((h) => id.includes(h))) {
        paint["line-color"] = NIGHT.roadMinor;
        touched++;
      }
    }
  }
  return touched;
}

// ---------------------------------------------------------------- pipeline ---
export type TransformReport = {
  localizedLayers: number;
  buildings3D: boolean;
  paletteLayers: number;
};

/**
 * Apply every transform to a style object. Clones first, so a cached upstream
 * style is never mutated and the light/dark variants can't contaminate one
 * another.
 */
export function transformStyle(
  input: StyleJson,
  dark: boolean
): { style: StyleJson; report: TransformReport } {
  const style: StyleJson = JSON.parse(JSON.stringify(input));
  const localizedLayers = localizeToHebrew(style);
  const paletteLayers = dark ? applyNightPalette(style) : 0;
  const buildings3D = injectBuildings3D(style, dark);
  return { style, report: { localizedLayers, buildings3D, paletteLayers } };
}

// Transformed styles are cached per URL+theme: the upstream JSON is hundreds of
// kilobytes and neither it nor our transforms change within a session.
const cache = new Map<string, StyleJson>();

/**
 * Fetch and transform a style.
 *
 * Returns null on ANY failure, which the caller treats as "use the plain URL".
 * The upstream style is large, so the fetch is given a generous timeout — but a
 * bounded one, so a hung CDN can't leave the map permanently empty.
 */
export async function loadStyle(
  url: string,
  dark: boolean,
  timeoutMs = 12000
): Promise<StyleJson | null> {
  const key = `${url}::${dark ? "dark" : "light"}`;
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`style HTTP ${res.status}`);
    const json = await res.json();
    if (!json || !Array.isArray(json.layers)) throw new Error("unexpected style shape");
    const { style, report } = transformStyle(json, dark);
    console.log(
      `[mapStyle] ${dark ? "night" : "day"}: ${report.localizedLayers} label layer(s) → Hebrew, ` +
        `3D buildings ${report.buildings3D ? "on" : "unavailable"}, ` +
        `${report.paletteLayers} layer(s) repainted`
    );
    cache.set(key, style);
    return style;
  } catch (e) {
    console.warn(
      "[mapStyle] interceptor unavailable, using the plain style URL:",
      e instanceof Error ? e.message : e
    );
    return null;
  }
}

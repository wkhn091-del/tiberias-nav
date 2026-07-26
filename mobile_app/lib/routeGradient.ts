// lib/routeGradient.ts — Phase 50: punch a transparent hole in the route
// ribbon exactly where the green lane corridor covers it.
//
// THE PROBLEM. The blue route ribbon and the green corridor were both drawn
// over the same asphalt, and the blue bled out around the (now much thinner)
// green ribbon — two pieces of guidance competing for one road. Phase 41
// answered this by collapsing the WHOLE ribbon to a hairline as the driver
// closed on the junction, and its own comment named the cost: "Fading the
// ribbon out entirely would answer 'which lane' at the cost of 'where next'."
// Hiding the layer outright (line-opacity 0) pays exactly that cost — the
// route beyond the turn vanishes too, and at 80° pitch that is most of the
// screen.
//
// THE FIX. line-opacity is per-layer, but line-gradient is per-POSITION. The
// route source already sets lineMetrics, so ["line-progress"] runs 0..1 along
// the route and a gradient can carry alpha. Making the gradient transparent
// only across the corridor's span hides the ribbon precisely where the green
// replaces it and leaves it at full strength everywhere else — including
// beyond the turn. One mechanism, no cost to "where next".
//
// The hole's alpha is driven by the same 0..1 yield ramp as before, so it
// fades in with distance instead of snapping on at one GPS tick.
//
// Pure module: no React, no MapLibre imports — unit-tested directly.

/** [progress 0..1, "#rrggbb"] */
export type GradientStop = [number, string];

/** The route ribbon's colour ramp: green at the car -> blue far ahead. */
export const ROUTE_RAMP: GradientStop[] = [
  [0, "#00E676"],
  [0.35, "#00E5C0"],
  [0.7, "#12B6FF"],
  [1, "#2D6BFF"],
];

/** Span of the route, in progress units, that the corridor covers. */
export type Hole = {
  t0: number;
  t1: number;
  /** 0 = ribbon untouched, 1 = fully transparent across the hole. */
  strength: number;
};

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/** Colour of `stops` at progress `t`, linearly interpolated, as "#rrggbb". */
export function rampColorAt(stops: GradientStop[], t: number): string {
  if (stops.length === 0) return "#000000";
  const x = clamp01(t);
  if (x <= stops[0][0]) return stops[0][1];
  if (x >= stops[stops.length - 1][0]) return stops[stops.length - 1][1];
  for (let i = 1; i < stops.length; i++) {
    const [ta, ca] = stops[i - 1];
    const [tb, cb] = stops[i];
    if (x <= tb) {
      const f = tb === ta ? 0 : (x - ta) / (tb - ta);
      const A = parseHex(ca);
      const B = parseHex(cb);
      const mix = A.map((v, k) => Math.round(v + (B[k] - v) * f));
      return "#" + mix.map((v) => v.toString(16).padStart(2, "0")).join("");
    }
  }
  return stops[stops.length - 1][1];
}

/** "#rrggbb" + alpha -> the "rgba(...)" form MapLibre accepts in a gradient. */
function withAlpha(hex: string, a: number): string {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`;
}

/**
 * A MapLibre `line-gradient` expression for `stops`, with the span
 * [hole.t0, hole.t1] faded to `1 - hole.strength` alpha.
 *
 * `featherT` is the progress distance over which the hole's edges ramp, so the
 * ribbon doesn't end in a hard chop against the corridor's start.
 *
 * ALWAYS returns a TOP-LEVEL interpolate on ["line-progress"] — MapLibre
 * rejects the property outright otherwise (the Phase 49 crash class), which is
 * why the expression is built here and asserted in tests rather than being
 * assembled inline in JSX.
 */
export function gradientWithHole(
  stops: GradientStop[],
  hole: Hole | null,
  featherT = 0.004
): (string | number | (string | number)[])[] {
  const base = stops.length ? stops : ROUTE_RAMP;
  const flat: (string | number)[] = [];

  const noHole =
    !hole ||
    hole.strength <= 0 ||
    !Number.isFinite(hole.t0) ||
    !Number.isFinite(hole.t1) ||
    clamp01(hole.t1) <= clamp01(hole.t0);

  if (noHole) {
    for (const [t, c] of base) flat.push(t, c);
  } else {
    const t0 = clamp01(hole.t0);
    const t1 = clamp01(hole.t1);
    const holeAlpha = 1 - clamp01(hole.strength);
    // Feather can't be so wide it inverts the stop order on a short hole.
    const f = Math.min(featherT, (t1 - t0) / 2.0001);
    const preT = t0 - f;
    const postT = t1 + f;
    const marks: [number, string][] = [];
    // Opaque ramp before the hole. The feather marks are emitted ONLY when
    // there is room for them inside 0..1: a hole that starts at 0 has no
    // "before" region and one that ends at 1 has no "after" region. Clamping
    // them instead would collide with the hole's own stop and produce a
    // non-increasing stop list — which MapLibre rejects outright, i.e. the
    // very crash class this module exists to avoid.
    for (const [t, c] of base) if (t < preT) marks.push([t, withAlpha(c, 1)]);
    if (preT > 0) marks.push([preT, withAlpha(rampColorAt(base, preT), 1)]);
    marks.push([t0, withAlpha(rampColorAt(base, t0), holeAlpha)]);
    marks.push([t1, withAlpha(rampColorAt(base, t1), holeAlpha)]);
    if (postT < 1) marks.push([postT, withAlpha(rampColorAt(base, postT), 1)]);
    // opaque ramp after the hole
    for (const [t, c] of base) if (t > postT) marks.push([t, withAlpha(c, 1)]);

    // Safety net for float collisions: nudge by an amount far below one pixel
    // of route, and drop anything that no longer fits under 1 rather than
    // clamping it onto its predecessor. MapLibre extends the final stop's
    // colour to the end of the line, so dropping is visually lossless.
    let prev = -1;
    for (const [t, c] of marks) {
      let tt = t <= prev ? prev + 1e-6 : t;
      if (tt > 1) continue;
      prev = tt;
      flat.push(tt, c);
    }
  }

  return ["interpolate", ["linear"], ["line-progress"], ...flat];
}

/**
 * Where the corridor sits along the route, in progress units.
 *
 * The corridor runs from the driver (or `maxCorridorM` back from the junction,
 * whichever is nearer the junction) to the maneuver point. Returns null when
 * any input is missing, which callers treat as "no hole".
 */
export function corridorHole(
  totalM: number | null | undefined,
  remainingM: number | null | undefined,
  maneuverDistanceM: number | null | undefined,
  strength: number,
  maxCorridorM = 250
): Hole | null {
  if (!Number.isFinite(totalM) || (totalM as number) <= 0) return null;
  if (!Number.isFinite(remainingM) || !Number.isFinite(maneuverDistanceM)) return null;
  if (strength <= 0) return null;
  const total = totalM as number;
  const traveledM = Math.max(0, total - (remainingM as number));
  const endM = traveledM + (maneuverDistanceM as number);
  const startM = Math.max(traveledM, endM - maxCorridorM);
  if (endM <= startM) return null;
  return { t0: clamp01(startM / total), t1: clamp01(endM / total), strength: clamp01(strength) };
}

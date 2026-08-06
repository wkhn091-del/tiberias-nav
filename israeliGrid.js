"use strict";

// israeliGrid.js — Israeli Transverse Mercator <-> WGS84.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS, AND WHY IT IS THE FIRST THING TO GET RIGHT
//
// Israeli municipal and government GIS data is very often published in ITM
// (Israeli Transverse Mercator, EPSG:2039) or the older ICS (EPSG:28193), not
// in WGS84. An ITM coordinate looks like:
//
//     X = 220123.4   Y = 632456.7
//
// Feed that to a map expecting lon/lat and every traffic light lands in the
// Gulf of Guinea — 220 degrees east wraps, 632 degrees of latitude is
// meaningless, and the failure is silent because GeoJSON has no units. This is
// the single most likely way an ingestion pipeline for Israeli data goes wrong,
// so detection and conversion come before anything else.
//
// No proj4 dependency: the inverse Transverse Mercator series is short, exact
// enough for point features (sub-centimetre over Israel), and having it inline
// means the ingester runs with nothing installed.
//
// DATUM: EPSG:2039 uses GRS80, which differs from WGS84 by well under a metre
// for this purpose. A traffic light is a ~3m object at the roadside; the datum
// shift is not the error that will bite you, the projection is.
// ---------------------------------------------------------------------------

/** EPSG:2039 — Israel 1993 / Israeli TM Grid. */
const ITM = {
  a: 6378137.0, // GRS80 semi-major
  f: 1 / 298.257222101, // GRS80 flattening
  lon0: (35.20451694444445 * Math.PI) / 180,
  lat0: (31.734393611111114 * Math.PI) / 180,
  k0: 1.0000067,
  falseEasting: 219529.584,
  falseNorthing: 626907.39,
};

/** EPSG:28193 — Israel 1923 / Palestine Grid (older municipal archives). */
const ICS = {
  a: 6378300.789, // Clarke 1880 (modified)
  f: 1 / 293.466307656, // via b = 6356566.435
  lon0: (35.21208055555556 * Math.PI) / 180,
  lat0: (31.734097222222223 * Math.PI) / 180,
  k0: 1.0,
  falseEasting: 170251.555,
  falseNorthing: 1126867.909,
};


/**
 * Meridian distance from the equator, standard series in e^2.
 * Accurate to millimetres at Israeli latitudes.
 */
function M(P, lat) {
  const { a, f } = P;
  const e2 = 2 * f - f * f;
  const e4 = e2 * e2;
  const e6 = e4 * e2;
  return (
    a *
    ((1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * lat -
      ((3 * e2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * lat) +
      ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * lat) -
      ((35 * e6) / 3072) * Math.sin(6 * lat))
  );
}

/** WGS84 lon/lat (degrees) -> grid easting/northing (metres). */
function toGrid(P, lonDeg, latDeg) {
  const { a, f, lon0, lat0, k0, falseEasting, falseNorthing } = P;
  const e2 = 2 * f - f * f;
  const ep2 = e2 / (1 - e2);
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;

  const N = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  const T = Math.tan(lat) ** 2;
  const C = ep2 * Math.cos(lat) ** 2;
  const A = (lon - lon0) * Math.cos(lat);
  const A2 = A * A;

  const easting =
    falseEasting +
    k0 *
      N *
      (A +
        ((1 - T + C) * A2 * A) / 6 +
        ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A2 * A2 * A) / 120);

  const northing =
    falseNorthing +
    k0 *
      (M(P, lat) -
        M(P, lat0) +
        N *
          Math.tan(lat) *
          (A2 / 2 +
            ((5 - T + 9 * C + 4 * C * C) * A2 * A2) / 24 +
            ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A2 * A2 * A2) / 720));

  return [easting, northing];
}

/** Grid easting/northing (metres) -> WGS84 [lon, lat] in degrees. */
function fromGrid(P, easting, northing) {
  const { a, f, lon0, lat0, k0, falseEasting, falseNorthing } = P;
  const e2 = 2 * f - f * f;
  const ep2 = e2 / (1 - e2);
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));

  const x = easting - falseEasting;
  const y = northing - falseNorthing;

  const Mv = M(P, lat0) + y / k0;
  const mu = Mv / (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256));

  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);

  const C1 = ep2 * Math.cos(phi1) ** 2;
  const T1 = Math.tan(phi1) ** 2;
  const N1 = a / Math.sqrt(1 - e2 * Math.sin(phi1) ** 2);
  const R1 = (a * (1 - e2)) / Math.pow(1 - e2 * Math.sin(phi1) ** 2, 1.5);
  const D = x / (N1 * k0);
  const D2 = D * D;

  const lat =
    phi1 -
    ((N1 * Math.tan(phi1)) / R1) *
      (D2 / 2 -
        ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D2 * D2) / 24 +
        ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D2 * D2 * D2) / 720);

  const lon =
    lon0 +
    (D -
      ((1 + 2 * T1 + C1) * D2 * D) / 6 +
      ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D2 * D2 * D) / 120) /
      Math.cos(phi1);

  return [(lon * 180) / Math.PI, (lat * 180) / Math.PI];
}

const itmToWgs84 = (e, n) => fromGrid(ITM, e, n);
const wgs84ToItm = (lon, lat) => toGrid(ITM, lon, lat);
const icsToWgs84 = (e, n) => fromGrid(ICS, e, n);

/**
 * Guess which coordinate system a pair is in.
 *
 * Detection by magnitude, which is unambiguous here: Israel spans roughly
 * lon 34.2-35.9 and lat 29.4-33.4, while ITM eastings run ~120k-280k and
 * northings ~380k-790k. ICS northings are ~1.0-1.4M. Nothing overlaps, so a
 * misclassification means the data is not Israeli at all — which is worth
 * knowing before it lands on a map.
 */
function detectCrs(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return "invalid";
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  if (ax <= 180 && ay <= 90) return "wgs84";
  if (ax > 100000 && ax < 400000 && ay > 300000 && ay < 900000) return "itm";
  if (ax > 100000 && ax < 400000 && ay >= 900000 && ay < 1500000) return "ics";
  return "unknown";
}

/** Normalise any of the above to [lon, lat], or null. */
function toWgs84(x, y) {
  switch (detectCrs(x, y)) {
    case "wgs84":
      // Published data is inconsistent about order. Israel's lon is always
      // greater than its lat, which disambiguates without a flag.
      return Math.abs(x) > Math.abs(y) ? [x, y] : [y, x];
    case "itm":
      return itmToWgs84(x, y);
    case "ics":
      return icsToWgs84(x, y);
    default:
      return null;
  }
}

module.exports = {
  ITM,
  ICS,
  itmToWgs84,
  wgs84ToItm,
  icsToWgs84,
  detectCrs,
  toWgs84,
};

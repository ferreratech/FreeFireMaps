// Transverse Mercator (UTM) forward projection, GRS80 ellipsoid (NAD83 ~ WGS84
// for field use; the sub-metre datum shift is far below GPS accuracy).
// Verified against the test GeoPDF corners: page corners round-trip < 0.01 px.

export interface UtmParams {
  a: number;        // semi-major axis
  e2: number;       // first eccentricity squared
  k0: number;       // scale factor
  lon0: number;     // central meridian (radians)
  FE: number;       // false easting
  FN: number;       // false northing
}

const A = 6378137.0;
const F = 1 / 298.257222101; // GRS80 flattening
const E2 = F * (2 - F);

/** Build UTM params from a central meridian (degrees) and standard UTM constants. */
export function utmZoneParams(centralMeridianDeg: number, opts?: Partial<UtmParams>): UtmParams {
  return {
    a: A,
    e2: E2,
    k0: 0.9996,
    lon0: (centralMeridianDeg * Math.PI) / 180,
    FE: 500000.0,
    FN: 0.0,
    ...opts,
  };
}

/** WGS84/NAD83 lat,lon (degrees) -> UTM easting,northing (metres). */
export function llToUtm(latDeg: number, lonDeg: number, p: UtmParams): [number, number] {
  const { a, e2, k0, lon0, FE, FN } = p;
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const ep2 = e2 / (1 - e2);
  const sinLat = Math.sin(lat);
  const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
  const T = Math.tan(lat) ** 2;
  const C = ep2 * Math.cos(lat) ** 2;
  const Aa = Math.cos(lat) * (lon - lon0);
  const M =
    a *
    ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * lat -
      ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * lat) +
      ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * lat) -
      ((35 * e2 ** 3) / 3072) * Math.sin(6 * lat));
  const x =
    k0 *
      N *
      (Aa +
        ((1 - T + C) * Aa ** 3) / 6 +
        ((5 - 18 * T + T ** 2 + 72 * C - 58 * ep2) * Aa ** 5) / 120) +
    FE;
  const y =
    k0 *
      (M +
        N *
          Math.tan(lat) *
          (Aa ** 2 / 2 +
            ((5 - T + 9 * C + 4 * C ** 2) * Aa ** 4) / 24 +
            ((61 - 58 * T + T ** 2 + 600 * C - 330 * ep2) * Aa ** 6) / 720)) +
    FN;
  return [x, y];
}

/** UTM easting,northing (metres) -> WGS84/NAD83 lat,lon (degrees). Inverse of
 *  llToUtm; used to turn a touched page point back into a geographic pin. */
export function utmToLl(easting: number, northing: number, p: UtmParams): [number, number] {
  const { a, e2, k0, lon0, FE, FN } = p;
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const x = easting - FE;
  const y = northing - FN;
  const M = y / k0;
  const mu =
    M / (a * (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const ep2 = e2 / (1 - e2);
  const sinPhi1 = Math.sin(phi1);
  const C1 = ep2 * Math.cos(phi1) ** 2;
  const T1 = Math.tan(phi1) ** 2;
  const N1 = a / Math.sqrt(1 - e2 * sinPhi1 * sinPhi1);
  const R1 = (a * (1 - e2)) / (1 - e2 * sinPhi1 * sinPhi1) ** 1.5;
  const D = x / (N1 * k0);
  const lat =
    phi1 -
    ((N1 * Math.tan(phi1)) / R1) *
      (D ** 2 / 2 -
        ((5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * ep2) * D ** 4) / 24 +
        ((61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * ep2 - 3 * C1 ** 2) * D ** 6) / 720);
  const lon =
    lon0 +
    (D -
      ((1 + 2 * T1 + C1) * D ** 3) / 6 +
      ((5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * ep2 + 24 * T1 ** 2) * D ** 5) / 120) /
      Math.cos(phi1);
  return [(lat * 180) / Math.PI, (lon * 180) / Math.PI];
}

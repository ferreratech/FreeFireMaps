// Field coordinate readouts and measurement. US fire crews radio positions in
// USNG (US National Grid == MGRS lettering on UTM/NAD83), and read distances
// in feet/miles (chains on older maps). Everything here is pure math over the
// UTM projection in ./utm so the gates can check it against published examples.
import { llToUtm, utmZoneParams } from './utm';

export interface UtmFix { zone: number; band: string; easting: number; northing: number }

/** UTM zone number for a longitude (Norway/Svalbard exceptions ignored — no fires there). */
export function utmZone(lon: number): number {
  return Math.max(1, Math.min(60, Math.floor((lon + 180) / 6) + 1));
}

const BANDS = 'CDEFGHJKLMNPQRSTUVWX'; // 8° latitude bands, -80..84
export function latBand(lat: number): string {
  const i = Math.max(0, Math.min(19, Math.floor((lat + 80) / 8)));
  return BANDS[i];
}

export function toUtm(lat: number, lon: number): UtmFix {
  const zone = utmZone(lon);
  const p = utmZoneParams(zone * 6 - 183, lat < 0 ? { FN: 10000000 } : {});
  const [e, n] = llToUtm(lat, lon, p);
  return { zone, band: latBand(lat), easting: e, northing: n };
}

// MGRS/USNG 100 km square letters. Column letters cycle in three 8-letter
// sets by zone; row letters use the 20-letter alphabet (no I or O) with a
// 5-row offset for even zones.
const COL_SETS = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];
const ROWS = 'ABCDEFGHJKLMNPQRSTUV';
export function squareId(zone: number, easting: number, northing: number): string {
  const col = COL_SETS[(zone - 1) % 3][Math.floor(easting / 100000) - 1];
  const row = ROWS[(Math.floor(northing / 100000) + (zone % 2 === 0 ? 5 : 0)) % 20];
  return `${col}${row}`;
}

/** e.g. "10S FE 12345 67890" (1 m precision, spaced like the USNG standard). */
export function toUsng(lat: number, lon: number, digits = 5): string {
  const u = toUtm(lat, lon);
  const div = 10 ** (5 - digits);
  const e = Math.floor((u.easting % 100000) / div).toString().padStart(digits, '0');
  const n = Math.floor((u.northing % 100000) / div).toString().padStart(digits, '0');
  return `${u.zone}${u.band} ${squareId(u.zone, u.easting, u.northing)} ${e} ${n}`;
}

/** Great-circle distance in metres. */
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371008.8;
  const toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR;
  const dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Initial bearing from point 1 to point 2, degrees true, 0..360. */
export function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toR = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * toR) * Math.cos(lat2 * toR);
  const x = Math.cos(lat1 * toR) * Math.sin(lat2 * toR) - Math.sin(lat1 * toR) * Math.cos(lat2 * toR) * Math.cos((lon2 - lon1) * toR);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export const FT_PER_M = 3.280839895;
export const M_PER_MI = 1609.344;

/** "1,234 ft" under a quarter mile, else "0.83 mi"; metric alongside. */
export function fmtDistance(m: number): string {
  const ft = m * FT_PER_M;
  const imperial = ft < 1320 ? `${Math.round(ft).toLocaleString()} ft` : `${(m / M_PER_MI).toFixed(2)} mi`;
  const metric = m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
  return `${imperial} · ${metric}`;
}

/** Total length of a polyline of lat/lon points, metres. */
export function pathLength(pts: { lat: number; lon: number }[]): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += haversine(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
  return d;
}

// Scale bar: pick the largest "nice" imperial length that fits in targetPx.
const NICE_FT = [20, 50, 100, 200, 500, 1000, 2000, 2640, 5280, 10560, 26400, 52800, 105600, 264000];
export interface ScaleBar { px: number; label: string; metric: string }
export function niceScale(metersPerPx: number, targetPx: number): ScaleBar | null {
  if (!(metersPerPx > 0) || !(targetPx > 0)) return null;
  const maxFt = targetPx * metersPerPx * FT_PER_M;
  let ft = NICE_FT[0];
  for (const n of NICE_FT) if (n <= maxFt) ft = n;
  const m = ft / FT_PER_M;
  const label = ft >= 2640 ? `${+(ft / 5280).toFixed(2)} mi` : `${ft} ft`;
  const metric = m >= 1000 ? `${+(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
  return { px: m / metersPerPx, label, metric };
}

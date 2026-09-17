// Parse the georeference out of a GeoPDF (ISO 32000-2 /Measure /GEO viewport)
// and build page-pixel <-> lat/lon transforms.
//
// We read the raw PDF bytes and pull the first /VP ... /Measure ... block:
//   /BBox [x0 y0 x1 y1]     the neatline rectangle (PDF points, bottom-left origin)
//   /GPTS [lat lon ...]     geographic corner points (WGS84/NAD83 degrees)
//   /LPTS [x y ...]         the matching corner points, relative (0..1) to BBox
//   /GCS ... /WKT (...)     projection; we read Central_Meridian for the UTM zone
//
// The transform is affine in PROJECTED (UTM) space, which is exact for these
// maps. lat/lon is projected to UTM first, then an affine maps UTM<->page.

import { Affine, applyAffine, solveAffine } from './affine';
import { llToUtm, utmToLl, utmZoneParams, UtmParams } from './utm';

export interface GeoRef {
  mediaWidth: number;    // page width in PDF points (top-left pixel space width)
  mediaHeight: number;   // page height in PDF points
  bbox: [number, number, number, number];
  gpts: [number, number][]; // [lat, lon]
  lpts: [number, number][]; // [rx, ry] relative to bbox
  utm: UtmParams;
  utmToPage: Affine;     // UTM metres -> page px (top-left origin)
  pageToUtm: Affine;     // page px (top-left origin) -> UTM metres
  cornerResidualPx: number; // max corner reprojection error, for self-check
}

function firstNumberArray(src: string, key: string): number[] | null {
  const re = new RegExp(key.replace(/[/]/g, '\\/') + '\\s*\\[([^\\]]*)\\]');
  const m = re.exec(src);
  if (!m) return null;
  return m[1]
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((n) => !Number.isNaN(n));
}

function readMediaBox(src: string): [number, number] {
  // /MediaBox [0 0 W H]
  const arr = firstNumberArray(src, '/MediaBox');
  if (arr && arr.length === 4) return [arr[2] - arr[0], arr[3] - arr[1]];
  return [0, 0];
}

function readCentralMeridian(src: string): number {
  const m = /Central_Meridian["']?\s*,\s*(-?\d+(?:\.\d+)?)/.exec(src);
  if (m) return parseFloat(m[1]);
  // Fall back: derive UTM zone longitude from the mean of GPTS if WKT is absent.
  return NaN;
}

/**
 * Build a GeoRef from raw PDF text (latin-1 decoded is fine — we only match
 * ASCII structure). Returns null if no georeference viewport is present.
 */
export function parseGeoRef(pdfText: string): GeoRef | null {
  // Narrow to the first Measure viewport block to avoid cross-matching.
  const vpIdx = pdfText.indexOf('/Measure');
  if (vpIdx < 0) return null;
  // Take a generous window around it (dicts here are a few hundred bytes).
  const win = pdfText.slice(Math.max(0, vpIdx - 2000), vpIdx + 4000);

  const bboxArr = firstNumberArray(win, '/BBox');
  const gptsArr = firstNumberArray(win, '/GPTS');
  const lptsArr = firstNumberArray(win, '/LPTS');
  if (!bboxArr || bboxArr.length !== 4 || !gptsArr || !lptsArr) return null;

  const [mw, mh] = readMediaBox(pdfText);
  const mediaWidth = mw || bboxArr[2];
  const mediaHeight = mh || bboxArr[3];

  const gpts: [number, number][] = [];
  for (let i = 0; i + 1 < gptsArr.length; i += 2) gpts.push([gptsArr[i], gptsArr[i + 1]]);
  const lpts: [number, number][] = [];
  for (let i = 0; i + 1 < lptsArr.length; i += 2) lpts.push([lptsArr[i], lptsArr[i + 1]]);

  let cm = readCentralMeridian(win);
  if (Number.isNaN(cm)) {
    const meanLon = gpts.reduce((s, g) => s + g[1], 0) / gpts.length;
    // UTM central meridian of the containing zone
    const zone = Math.floor((meanLon + 180) / 6) + 1;
    cm = zone * 6 - 183;
  }
  const utm = utmZoneParams(cm);

  const [bx0, by0, bx1, by1] = bboxArr as [number, number, number, number];
  const bw = bx1 - bx0;
  const bh = by1 - by0;

  // Page pixel space: TOP-LEFT origin (what an image/overlay uses).
  // PDF y is bottom-left, so flip: py_tl = mediaHeight - py_pdf.
  const pageCorners: [number, number][] = lpts.map(([rx, ry]) => {
    const pxPdf = bx0 + rx * bw;
    const pyPdf = by0 + ry * bh;
    return [pxPdf, mediaHeight - pyPdf];
  });
  const utmCorners: [number, number][] = gpts.map(([lat, lon]) => llToUtm(lat, lon, utm));

  const pageToUtm = solveAffine(pageCorners, utmCorners);
  const utmToPage = solveAffine(utmCorners, pageCorners);

  // Self-check: reproject each geo corner to page, compare to the known page corner.
  let cornerResidualPx = 0;
  for (let i = 0; i < gpts.length; i++) {
    const u = llToUtm(gpts[i][0], gpts[i][1], utm);
    const [px, py] = applyAffine(utmToPage, u[0], u[1]);
    const d = Math.hypot(px - pageCorners[i][0], py - pageCorners[i][1]);
    if (d > cornerResidualPx) cornerResidualPx = d;
  }

  return {
    mediaWidth,
    mediaHeight,
    bbox: bboxArr as [number, number, number, number],
    gpts,
    lpts,
    utm,
    utmToPage,
    pageToUtm,
    cornerResidualPx,
  };
}

/** lat/lon (degrees) -> page pixel (top-left origin, PDF-point units). */
export function latLonToPage(geo: GeoRef, lat: number, lon: number): [number, number] {
  const u = llToUtm(lat, lon, geo.utm);
  return applyAffine(geo.utmToPage, u[0], u[1]);
}

/** True if the lat/lon falls inside the georeferenced neatline rectangle. */
export function isInsideMap(geo: GeoRef, lat: number, lon: number): boolean {
  const [px, py] = latLonToPage(geo, lat, lon);
  const [bx0, by0, bx1, by1] = geo.bbox;
  const xMin = Math.min(bx0, bx1);
  const xMax = Math.max(bx0, bx1);
  // page py is top-left; bbox is PDF bottom-left -> convert for the y test
  const yTop = geo.mediaHeight - Math.max(by0, by1);
  const yBot = geo.mediaHeight - Math.min(by0, by1);
  return px >= xMin - 1 && px <= xMax + 1 && py >= yTop - 1 && py <= yBot + 1;
}

/** page pixel (top-left origin, PDF-point units) -> lat/lon (degrees). Inverse
 *  of latLonToPage. Used to turn a touched map point into a saved waypoint. */
export function pageToLatLon(geo: GeoRef, px: number, py: number): [number, number] {
  const [e, n] = applyAffine(geo.pageToUtm, px, py);
  return utmToLl(e, n, geo.utm);
}

/** Approximate: meters on the ground -> page pixels, using the local scale of
 *  the page<->UTM affine (page px per UTM metre). Good for an accuracy circle. */
export function metersToPagePx(geo: GeoRef, meters: number): number {
  // The utmToPage affine's linear part gives px per metre; take its average
  // magnitude across x and y (the map is near-conformal at this scale).
  const [a, b, , d, e] = geo.utmToPage;
  const sx = Math.hypot(a, d); // px per metre in easting
  const sy = Math.hypot(b, e); // px per metre in northing
  return (meters * (sx + sy)) / 2;
}

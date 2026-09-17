// Verify the georeference transform against the real test GeoPDF, using the
// SAME TypeScript modules the app ships. We transpile them on the fly with the
// TypeScript compiler API (already a dev dependency) so there is no separate
// math to drift out of sync.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import Module from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Minimal TS->CJS loader for our lib/*.ts files.
const cache = {};
function loadTs(rel) {
  if (cache[rel]) return cache[rel].exports;
  const file = path.resolve(root, rel);
  const source = fs.readFileSync(file, 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText;
  const m = { exports: {} };
  cache[rel] = m;
  const dir = path.dirname(file);
  const require2 = (spec) => {
    if (spec.startsWith('.')) {
      let p = path.resolve(dir, spec);
      if (!p.endsWith('.ts')) p += '.ts';
      return loadTs(path.relative(root, p));
    }
    return Module.createRequire(file)(spec);
  };
  const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', js);
  fn(m.exports, require2, m, file, dir);
  return m.exports;
}

const { parseGeoRef, latLonToPage, isInsideMap, pageToLatLon } = loadTs('lib/geopdf.ts');

const pdfPath = path.resolve(root, 'test-maps/Timber_CALPF002271_20260911_DIV_F-H_ops.pdf');
const buf = fs.readFileSync(pdfPath);
const text = buf.toString('latin1');

const geo = parseGeoRef(text);
if (!geo) {
  console.error('FAIL: no georeference parsed');
  process.exit(1);
}

let ok = true;
const line = (s) => console.log(s);
line('=== Parsed georeference ===');
line(`  media: ${geo.mediaWidth} x ${geo.mediaHeight} pt`);
line(`  bbox:  [${geo.bbox.join(' ')}]`);
line(`  UTM central meridian: ${(Math.atan2(0,1),(geo.utm.lon0*180/Math.PI)).toFixed(1)} deg`);
line(`  corners (GPTS): ${geo.gpts.map((g)=>g.join(',')).join('  ')}`);
line(`  max corner residual: ${geo.cornerResidualPx.toExponential(2)} px`);
line('');

// 1. Corner round-trip test.
line('=== Corner round-trip (each GPTS -> page px vs known BBox corner) ===');
const [bx0, by0, bx1, by1] = geo.bbox;
const bw = bx1 - bx0, bh = by1 - by0;
for (let i = 0; i < geo.gpts.length; i++) {
  const [lat, lon] = geo.gpts[i];
  const [rx, ry] = geo.lpts[i];
  const expX = bx0 + rx * bw;
  const expY = geo.mediaHeight - (by0 + ry * bh);
  const [px, py] = latLonToPage(geo, lat, lon);
  const err = Math.hypot(px - expX, py - expY);
  if (err > 0.5) ok = false;
  line(`  corner ${i}: expect (${expX.toFixed(1)}, ${expY.toFixed(1)})  got (${px.toFixed(2)}, ${py.toFixed(2)})  err=${err.toFixed(3)} px`);
}
if (geo.cornerResidualPx > 0.5) ok = false;
line('');

// 2. Center + quadrant monotonicity.
line('=== Center + quadrant sanity ===');
const clat = geo.gpts.reduce((s,g)=>s+g[0],0)/geo.gpts.length;
const clon = geo.gpts.reduce((s,g)=>s+g[1],0)/geo.gpts.length;
const [cx, cy] = latLonToPage(geo, clat, clon);
const midX = (bx0 + bx1) / 2;
const midY = geo.mediaHeight - (by0 + by1) / 2;
const cErr = Math.hypot(cx - midX, cy - midY);
if (cErr > 5) ok = false;
line(`  center ${clat.toFixed(5)},${clon.toFixed(5)} -> (${cx.toFixed(1)}, ${cy.toFixed(1)}); page-center (${midX.toFixed(1)}, ${midY.toFixed(1)}); err=${cErr.toFixed(2)} px`);

const quad = [
  ['NE (higher lat, less-neg lon)', 36.36, -121.67, 'right', 'top'],
  ['SW', 36.22, -121.94, 'left', 'bottom'],
];
for (const [name, lat, lon] of quad) {
  const [px, py] = latLonToPage(geo, lat, lon);
  line(`  ${name}: ${lat},${lon} -> (${px.toFixed(0)}, ${py.toFixed(0)})  inside=${isInsideMap(geo, lat, lon)}`);
}
// Assert NE is right-of and above SW
const ne = latLonToPage(geo, 36.36, -121.67);
const sw = latLonToPage(geo, 36.22, -121.94);
if (!(ne[0] > sw[0] && ne[1] < sw[1])) { ok = false; line('  FAIL: NE not upper-right of SW'); }
line('');

// 3. A point OUTSIDE the bounds should report not-inside.
const outside = isInsideMap(geo, 34.0, -118.0); // Los Angeles, far away
line(`=== Bounds check: LA (34,-118) inside=${outside} (expect false) ===`);
if (outside) ok = false;
line('');

// 4. INVERSE round-trip (pins depend on this): lat/lon -> page px -> lat/lon
//    must return the original within tolerance. Test a grid inside the bounds.
line('=== Inverse round-trip: latlon -> page -> latlon (pins land where dropped) ===');
const latMin = Math.min(...geo.gpts.map((g) => g[0]));
const latMax = Math.max(...geo.gpts.map((g) => g[0]));
const lonMin = Math.min(...geo.gpts.map((g) => g[1]));
const lonMax = Math.max(...geo.gpts.map((g) => g[1]));
let maxErrM = 0;
const R = 6378137; // metres, for a rough deg/metre error
for (let i = 1; i <= 4; i++) {
  for (let j = 1; j <= 4; j++) {
    const lat = latMin + ((latMax - latMin) * i) / 5;
    const lon = lonMin + ((lonMax - lonMin) * j) / 5;
    const [px, py] = latLonToPage(geo, lat, lon);
    const [lat2, lon2] = pageToLatLon(geo, px, py);
    const dLatM = (lat2 - lat) * (Math.PI / 180) * R;
    const dLonM = (lon2 - lon) * (Math.PI / 180) * R * Math.cos((lat * Math.PI) / 180);
    const errM = Math.hypot(dLatM, dLonM);
    if (errM > maxErrM) maxErrM = errM;
  }
}
line(`  max round-trip error over a 4x4 interior grid: ${maxErrM.toExponential(2)} m`);
if (maxErrM > 0.01) { ok = false; line('  FAIL: inverse round-trip exceeds 1 cm'); }
line('');

line(ok ? 'RESULT: PASS ✓  transform + inverse verified against real GeoPDF' : 'RESULT: FAIL ✗');
process.exit(ok ? 0 : 1);

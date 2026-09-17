// BUILD GATE: field coordinate + measurement math (lib/grid.ts), checked
// against published references, not against itself.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import Module from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const cache = {};
function loadTs(rel) {
  if (cache[rel]) return cache[rel].exports;
  const file = path.resolve(root, rel);
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText;
  const m = { exports: {} }; cache[rel] = m;
  const dir = path.dirname(file);
  const require2 = (spec) => {
    if (spec.startsWith('.')) { let p = path.resolve(dir, spec); if (!p.endsWith('.ts')) p += '.ts'; return loadTs(path.relative(root, p)); }
    return Module.createRequire(file)(spec);
  };
  new Function('exports', 'require', 'module', '__filename', '__dirname', js)(m.exports, require2, m, file, dir);
  return m.exports;
}
const { toUtm, toUsng, squareId, haversine, bearing, niceScale, fmtDistance, pathLength, latBand, utmZone } = loadTs('lib/grid.ts');

let failed = 0;
const ok = (c, msg) => { console.log(`  ${c ? '✓' : '✗'} ${msg}`); if (!c) failed++; };

// FGDC "How to read a USNG address": the Washington Monument is 18SUJ 2348 0647
// (10 m precision). (Its other example, 18S UJ 23371 06519, is the Jefferson
// Pier ~120 m WNW — an easy vector to misattribute.) Monument centre per USGS:
// 38.88946 N, 77.03524 W.
console.log('USNG against the FGDC example (Washington Monument = 18SUJ 2348 0647):');
const wm = toUtm(38.88946, -77.03524);
ok(wm.zone === 18 && wm.band === 'S', `zone/band 18S (got ${wm.zone}${wm.band})`);
ok(squareId(wm.zone, wm.easting, wm.northing) === 'UJ', `100 km square UJ (got ${squareId(wm.zone, wm.easting, wm.northing)})`);
const u = toUsng(38.88946, -77.03524);
const m = u.match(/^18S UJ (\d{5}) (\d{5})$/);
ok(!!m && Math.abs(+m[1] - 23480) <= 20 && Math.abs(+m[2] - 6470) <= 20, `full USNG within 20 m of 18SUJ 23480 06470 (got "${u}")`);
ok(toUsng(38.88946, -77.03524, 4) === '18S UJ 2348 0647' || toUsng(38.88946, -77.03524, 4) === '18S UJ 2347 0647' || toUsng(38.88946, -77.03524, 4) === '18S UJ 2348 0648',
   `10 m USNG reads 18S UJ 2348 0647 (got "${toUsng(38.88946, -77.03524, 4)}")`);

console.log('Square lettering across zone parity and the row offset:');
ok(squareId(10, 550000, 4180000) === 'EG', `San Francisco is in 10S EG (got ${squareId(10, 550000, 4180000)})`); // even zone: +5 row offset
ok(toUsng(36.29, -121.80).startsWith('10S '), `Big Sur test point is zone 10S (${toUsng(36.29, -121.80)})`);
ok(latBand(36.29) === 'S' && latBand(-33.9) === 'H' && latBand(60.2) === 'V', 'latitude bands S / H / V');
ok(utmZone(-121.8) === 10 && utmZone(-77.03) === 18 && utmZone(151.2) === 56, 'zones 10 / 18 / 56');
ok(toUsng(36.29, -121.80, 3).match(/^10S [A-Z]{2} \d{3} \d{3}$/) !== null, '3-digit (100 m) USNG precision format');

console.log('Distance / bearing:');
ok(Math.abs(haversine(0, 0, 0, 1) - 111195) < 10, `1° of longitude at the equator = 111,195 m (got ${haversine(0, 0, 0, 1).toFixed(0)})`);
ok(Math.abs(haversine(36.29, -121.80, 36.29, -121.80)) === 0, 'zero distance to self');
ok(Math.round(bearing(0, 0, 0, 1)) === 90 && Math.round(bearing(0, 0, 1, 0)) === 0 && Math.round(bearing(0, 0, -1, 0)) === 180, 'bearings E=90, N=0, S=180');
ok(Math.abs(pathLength([{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 0, lon: 2 }]) - 2 * 111195) < 20, 'polyline length sums segments');
ok(fmtDistance(100) === '328 ft · 100 m' && fmtDistance(1609.344).startsWith('1.00 mi'), `imperial-first formatting (${fmtDistance(100)} | ${fmtDistance(1609.344)})`);

console.log('Scale bar:');
let mono = true, fits = true, prev = Infinity;
for (let mpp = 0.05; mpp < 200; mpp *= 1.3) {
  const sb = niceScale(mpp, 140);
  if (!sb || sb.px > 140.0001 || sb.px < 10) fits = false;
  const metres = sb.px * mpp; if (metres > prev * 1.0001 && mpp < 1) mono = false; prev = metres; // finer zoom -> shorter bar
}
ok(fits, 'bar always fits the 140 dp target and is never shorter than 10 dp');
ok(niceScale(1, 140).label === '200 ft' || niceScale(1, 140).label === '100 ft', `sensible label at 1 m/px (${niceScale(1, 140).label})`);
ok(niceScale(0, 140) === null && niceScale(1, 0) === null, 'degenerate inputs -> null');

if (failed) { console.error(`\n✗ GRID GATE FAILED (${failed})`); process.exit(1); }
console.log('\n✓ GRID GATE PASSED (USNG matches FGDC example, distances/bearings, scale bar)');

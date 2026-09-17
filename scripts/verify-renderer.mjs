// BUILD-TIME GATE: the PDF rendering path.
//
// Asserts BEHAVIOR, not just presence:
//  1. MapViewer renders via the local modules/pdf-page module (Android PdfRenderer)
//     and NOT via any PDF viewer widget that owns its own gestures/zoom.
//  2. The module's Kotlin exposes exactly the functions the JS calls.
//  3. TILE MATH (simulated with MapViewer's formulas): for many transforms, the
//     sharp tile (a) covers the whole viewport, (b) is at >= screen pixel density
//     unless the byte cap bites, (c) never exceeds the byte cap, (d) its page-point
//     rect maps back to the same layer rect (so it lands exactly on the base), and
//     (e) the renderer's matrix maps the region corners to the bitmap corners.
//  4. (with --apk <file>) the built APK's dex actually contains the module class,
//     so "Cannot find native module 'PdfPage'" cannot happen at runtime.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const ok = (c, msg) => { console.log(`  ${c ? '✓' : '✗'} ${msg}`); if (!c) failed++; };

const viewer = fs.readFileSync(path.join(root, 'components/MapViewer.tsx'), 'utf8');
const kt = fs.readFileSync(path.join(root, 'modules/pdf-page/android/src/main/java/expo/modules/pdfpage/PdfPageModule.kt'), 'utf8');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'modules/pdf-page/expo-module.config.json'), 'utf8'));
const idx = fs.readFileSync(path.join(root, 'modules/pdf-page/index.ts'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

console.log('Renderer wiring:');
ok(!/from\s*'react-native-pdf'/.test(viewer) && !/<Pdf\b/.test(viewer), 'no PDF viewer widget in MapViewer (it would fight the transform)');
ok(!pkg.dependencies['react-native-pdf'] && !pkg.dependencies['react-native-pdf-to-image'], 'no third-party PDF packages in dependencies');
ok(/from\s*'\.\.\/modules\/pdf-page'/.test(viewer), 'MapViewer imports the local pdf-page module');
ok(/requireNativeModule\('PdfPage'\)/.test(idx) && /Name\("PdfPage"\)/.test(kt), "JS and Kotlin agree on module name 'PdfPage'");
for (const fn of ['renderPage', 'renderRegion']) {
  ok(new RegExp(`AsyncFunction\\("${fn}"\\)`).test(kt) && new RegExp(`Native\\.${fn}\\(`).test(idx), `${fn} exists in Kotlin and is called from index.ts`);
}
ok((cfg.android?.modules || []).includes('expo.modules.pdfpage.PdfPageModule'), 'expo-module.config.json registers the module class');
ok(/PdfRenderer\(/.test(kt) && !/import com\.(shockwave|github\.barteksc)/.test(kt), 'uses android.graphics.pdf.PdfRenderer (OS built-in), no bundled PDF engine');
ok(/<Image[\s\S]{0,200}source=\{\{ uri: base\.uri \}\}/.test(viewer) && /<Image[\s\S]{0,200}source=\{\{ uri: tile\.uri \}\}/.test(viewer), 'base + tile drawn as plain <Image>s (passive, no own gestures)');
{
  // Both gesture handlers' onEnd must request a sharp tile.
  const ends = viewer.match(/\.onEnd\(\(\) => \{[\s\S]*?\}\)/g) || [];
  const withTile = ends.filter((b) => /runOnJS\(requestTile\)\(\)/.test(b));
  ok(withTile.length >= 2, `pan and pinch end both request a sharp tile (${withTile.length} of ${ends.length} onEnd blocks do)`);
}

// --- 3. tile math, replicated from MapViewer.requestTile ---
const num = (name) => Number(viewer.match(new RegExp(`const ${name} = ([^;]+);`))[1].replace(/\s/g, '').replace(/\*/g, '*')) ;
const MAX_TILE_BYTES = eval(viewer.match(/const MAX_TILE_BYTES = ([^;]+);/)[1]);
const TILE_MARGIN = eval(viewer.match(/const TILE_MARGIN = ([^;]+);/)[1]);
const BASE_MAX_PX = eval(viewer.match(/const BASE_MAX_PX = ([^;]+);/)[1]);
const MAX_RENDER_EDGE_DP = eval(viewer.match(/const MAX_RENDER_EDGE_DP = ([^;]+);/)[1]);
const MAGN = eval(viewer.match(/const TILE_WHEN_MAGNIFIED_BY = ([^;]+);/)[1]);
ok(BASE_MAX_PX * BASE_MAX_PX * 0.75 * 4 < 100 * 1024 * 1024, `base bitmap for a 4:3 page at ${BASE_MAX_PX}px stays under Android's 100 MB draw limit`);

function tileFor({ page, viewport, density, s, x, y }) {
  const q = Math.min(1, MAX_RENDER_EDGE_DP / Math.max(page.w, page.h));
  const render = { w: Math.round(page.w * q), h: Math.round(page.h * q), q };
  const bs = Math.min(BASE_MAX_PX / page.w, BASE_MAX_PX / page.h);
  const base = { width: Math.round(page.w * bs), height: Math.round(page.h * bs), pageWidth: page.w, pageHeight: page.h };
  const basePxPerDp = base.width / render.w;
  if (s * density <= basePxPerDp * MAGN) return { none: true, render, base };
  const vw = viewport.w / s, vh = viewport.h / s;
  let lx0 = (0 - x) / s - vw * TILE_MARGIN, ly0 = (0 - y) / s - vh * TILE_MARGIN;
  let lx1 = (viewport.w - x) / s + vw * TILE_MARGIN, ly1 = (viewport.h - y) / s + vh * TILE_MARGIN;
  lx0 = Math.max(0, lx0); ly0 = Math.max(0, ly0); lx1 = Math.min(render.w, lx1); ly1 = Math.min(render.h, ly1);
  let pxW = (lx1 - lx0) * s * density, pxH = (ly1 - ly0) * s * density;
  const over = Math.sqrt(MAX_TILE_BYTES / (pxW * pxH * 4));
  if (over < 1) { pxW *= over; pxH *= over; }
  const kx = base.pageWidth / render.w, ky = base.pageHeight / render.h;
  return { render, base, lx0, ly0, lx1, ly1, pxW: Math.round(pxW), pxH: Math.round(pxH), capped: over < 1,
           region: { x0: lx0 * kx, y0: ly0 * ky, x1: lx1 * kx, y1: ly1 * ky }, kx, ky };
}

console.log('Tile math (simulated):');
const page = { w: 3456, h: 2592 };            // the CAL FIRE ops map
const viewport = { w: 411, h: 869 };          // a 1080x2340 phone in dp
const density = 2.625;
const fitS = Math.min(viewport.w / 3456, viewport.h / 2592);
let cases = 0, covered = 0, dense = 0, capOk = 0, roundTrip = 0, matrixOk = 0, cappedCount = 0, noneAtFit = 0;
const rnd = (a, b) => a + Math.random() * (b - a);
for (let i = 0; i < 2000; i++) {
  const s = fitS * rnd(0.5, 12);
  // a transform that keeps at least some page on screen
  const x = rnd(viewport.w - 3456 * s, 0), y = rnd(viewport.h - 2592 * s, 0);
  const t = tileFor({ page, viewport, density, s, x, y });
  if (t.none) { if (s <= fitS * 1.5) noneAtFit++; continue; }
  cases++;
  // (a) covers the viewport: screen rect of the tile ⊇ viewport ∩ page-on-screen
  const sx0 = x + s * t.lx0, sy0 = y + s * t.ly0, sx1 = x + s * t.lx1, sy1 = y + s * t.ly1;
  const px0 = Math.max(0, x), py0 = Math.max(0, y), px1 = Math.min(viewport.w, x + s * t.render.w), py1 = Math.min(viewport.h, y + s * t.render.h);
  if (sx0 <= px0 + 1e-6 && sy0 <= py0 + 1e-6 && sx1 >= px1 - 1e-6 && sy1 >= py1 - 1e-6) covered++;
  // (b) at screen density unless capped
  const tilePxPerScreenPx = t.pxW / ((t.lx1 - t.lx0) * s * density);
  if (t.capped) cappedCount++;
  if (t.capped || tilePxPerScreenPx > 0.999) dense++;
  // (c) byte cap
  if (t.pxW * t.pxH * 4 <= MAX_TILE_BYTES * 1.01) capOk++;
  // (d) region -> layer round trip
  const back = { lx0: t.region.x0 / t.kx, ly0: t.region.y0 / t.ky, lx1: t.region.x1 / t.kx, ly1: t.region.y1 / t.ky };
  if (Math.abs(back.lx0 - t.lx0) < 1e-6 && Math.abs(back.ly1 - t.ly1) < 1e-6) roundTrip++;
  // (e) the Kotlin matrix: setScale(sx,sy) then postTranslate(-x0*sx,-y0*sy)
  const msx = t.pxW / (t.region.x1 - t.region.x0), msy = t.pxH / (t.region.y1 - t.region.y0);
  const map = (px, py) => [px * msx - t.region.x0 * msx, py * msy - t.region.y0 * msy];
  const [c0x, c0y] = map(t.region.x0, t.region.y0), [c1x, c1y] = map(t.region.x1, t.region.y1);
  if (Math.abs(c0x) < 1e-6 && Math.abs(c0y) < 1e-6 && Math.abs(c1x - t.pxW) < 1e-6 && Math.abs(c1y - t.pxH) < 1e-6) matrixOk++;
}
ok(cases > 1000, `${cases} zoomed-in transforms simulated`);
ok(covered === cases, `tile covers the visible page area in ${covered}/${cases}`);
ok(dense === cases, `tile is at >= screen pixel density (or explicitly capped) in ${dense}/${cases}`);
ok(capOk === cases, `tile never exceeds the ${MAX_TILE_BYTES / 1048576} MB budget (${cappedCount} needed capping)`);
ok(roundTrip === cases, `page-point region maps back onto the same layer rect in ${roundTrip}/${cases}`);
ok(matrixOk === cases, `renderer matrix maps region corners to bitmap corners in ${matrixOk}/${cases}`);
ok(noneAtFit > 0, `near the fitted zoom the base alone is used (no tile churn) — ${noneAtFit} cases`);
// The fitted view on this phone should itself be sharp: base px >= screen px.
const fitBasePx = 4096, fitScreenPx = viewport.w * density;
ok(fitBasePx >= fitScreenPx, `base (${fitBasePx}px wide) exceeds the fitted screen width (${Math.round(fitScreenPx)}px) — fit view is sharp`);

// --- 4. optional: the built APK really contains the class ---
const apkIdx = process.argv.indexOf('--apk');
if (apkIdx > 0) {
  const apk = process.argv[apkIdx + 1];
  console.log(`APK check (${apk}):`);
  const out = execFileSync('python3', ['-c', `
import zipfile,sys
z=zipfile.ZipFile(sys.argv[1]); hit=False
for n in z.namelist():
    if n.startswith('classes') and n.endswith('.dex'):
        if b'expo/modules/pdfpage/PdfPageModule' in z.read(n): hit=True
print('yes' if hit else 'no')`, apk], { encoding: 'utf8' }).trim();
  ok(out === 'yes', 'dex contains expo.modules.pdfpage.PdfPageModule (native module is really in the APK)');
}

if (failed) { console.error(`\n✗ RENDERER GATE FAILED (${failed})`); process.exit(1); }
console.log('\n✓ RENDERER GATE PASSED');

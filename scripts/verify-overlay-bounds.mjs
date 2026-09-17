// BUILD GATE: the SVG overlay must be VIEWPORT-bound, never page-bound, and
// must sit OUTSIDE the zoom transform. react-native-svg rasterizes its whole
// view into one bitmap; a page-sized overlay (3456x2592 dp at 2.75x density =
// 271 MB) exceeds Android's ~100 MB single-bitmap limit and crashes in
// SvgView.onDraw. This static check makes that regression a build failure.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'components/MapViewer.tsx');
// Strip comments so prose like "<Svg>" in a comment isn't mistaken for JSX.
const src = fs
  .readFileSync(file, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
let ok = true;
const fail = (m) => { ok = false; console.error('  ✗ ' + m); };
const pass = (m) => console.log('  ✓ ' + m);

console.log('Overlay bounds gate (components/MapViewer.tsx):');

// Every <Svg ...> opening tag, with its attributes.
const svgTags = [...src.matchAll(/<Svg\b([^>]*)>/gs)];
if (svgTags.length === 0) fail('no <Svg> found');
for (const m of svgTags) {
  const attrs = m[1];
  if (/width=\{viewport\.w\}/.test(attrs) && /height=\{viewport\.h\}/.test(attrs)) {
    pass('<Svg> width/height bound to viewport');
  } else {
    fail('<Svg> width/height are not {viewport.w}/{viewport.h}: ' + attrs.replace(/\s+/g, ' ').trim());
  }
  if (/(width|height)=\{(render|media|pageSize)\./.test(attrs)) fail('<Svg> sized from the page/render');
  // Must not be inside the transformed map layer: it has to come after the
  // GestureDetector/Animated.View block closes.
  const closeIdx = src.indexOf('</GestureDetector>');
  if (closeIdx < 0 || m.index < closeIdx) fail('<Svg> is inside the transformed map layer');
  else pass('<Svg> is outside the zoom transform (sibling of the map layer)');
}

// Overlay contents must be projected through the transform, not scaled by it.
if (/useAnimatedProps/.test(src) && /xf\.scale\.value \* l[xy]/.test(src)) pass('overlay contents projected via shared values');
else fail('overlay contents are not projected via useAnimatedProps');

// The single-surface byte cap must exist and be applied to the PDF render size.
// The page bitmap is now rendered by modules/pdf-page at a PIXEL cap (not a dp
// size at device density), so the cap is the base long edge: 4096 px * 3072 px
// * 4 B = 48 MB for a 4:3 page, under the ~100 MB draw limit. The sharp tile
// has its own byte budget.
const basePx = Number((src.match(/const BASE_MAX_PX = (\d+);/) || [])[1]);
const tileBytes = (() => { try { return eval((src.match(/const MAX_TILE_BYTES = ([^;]+);/) || [])[1]); } catch { return NaN; } })();
if (basePx && basePx * basePx * 4 <= 96 * 1024 * 1024 && /renderPage\(fileUri, 0, BASE_MAX_PX, BASE_MAX_PX\)/.test(src)) {
  pass(`page bitmap capped at ${basePx}px long edge (<= ${Math.round(basePx*basePx*4/1048576)} MB even if square)`);
} else fail('missing pixel cap on the base page bitmap');
if (tileBytes && tileBytes <= 64 * 1024 * 1024 && /over < 1\) \{ pxW \*= over; pxH \*= over; \}/.test(src)) {
  pass(`sharp tile capped at ${tileBytes/1048576} MB`);
} else fail('missing byte cap on the sharp tile');

console.log(ok ? '\n✓ OVERLAY GATE PASSED' : '\n✗ OVERLAY GATE FAILED');
process.exit(ok ? 0 : 1);

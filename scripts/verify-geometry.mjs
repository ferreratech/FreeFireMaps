// BUILD GATE: the pan/zoom + overlay geometry must hold the invariants that a
// human checks by eye. This replicates MapViewer's formulas exactly (no RN) and
// would have caught the corner-drift / flying-dot regression before gradle.
const render = { w: 3456, h: 2592 };
const vp = { w: 1080, h: 2200 };
const s0 = Math.min(vp.w / render.w, vp.h / render.h);
let tx = (vp.w - render.w * s0) / 2, ty = (vp.h - render.h * s0) / 2, scale = s0;
const screen = (lx, ly) => [tx + scale * lx, ty + scale * ly];
const fails = []; const ok = (c, m) => { if (!c) fails.push(m); };

const c = screen(render.w / 2, render.h / 2);
ok(Math.abs(c[0] - vp.w / 2) < 1e-9 && Math.abs(c[1] - vp.h / 2) < 1e-9, 'fit is not centered');

const focal = [300, 900];
const under = [(focal[0] - tx) / scale, (focal[1] - ty) / scale];
for (const e of [1.5, 2.0, 3.0, 0.7, 4.0, 0.4]) {
  const next = Math.max(s0 * 0.5, Math.min(s0 * 12, scale * e));
  const dz = next / scale;
  tx = focal[0] - (focal[0] - tx) * dz; ty = focal[1] - (focal[1] - ty) * dz; scale = next;
  const now = screen(...under);
  ok(Math.abs(now[0] - focal[0]) < 1e-6 && Math.abs(now[1] - focal[1]) < 1e-6,
    `pinch x${e}: point under fingers drifted to ${now.map(v => v.toFixed(2))}`);
}
const pinL = [2500, 600];
const a = screen(...pinL), b = [tx + scale * pinL[0], ty + scale * pinL[1]];
ok(a[0] === b[0] && a[1] === b[1], 'overlay projection != map transform (dot would fly)');
const sp = [500, 1200]; const L = [(sp[0] - tx) / scale, (sp[1] - ty) / scale]; const back = screen(...L);
ok(Math.abs(back[0] - sp[0]) < 1e-9 && Math.abs(back[1] - sp[1]) < 1e-9, 'long-press inverse not exact');
ok(scale >= s0 * 0.5 - 1e-12, 'zoom-out went below the floor');

// Source-level: the ONLY map transform must be top-left origin with NO pivot compensation.
import { readFileSync } from 'node:fs';

// --- CONCURRENT pan + pinch (the v5 bug) ---------------------------------------
// RNGH runs Pan and Pinch Simultaneous: during a two-finger pinch BOTH handlers
// fire every frame. Model the handlers exactly as MapViewer does and drive them
// with a realistic event stream: fingers spreading around a focal point (pinch
// scale grows; pan translation ~0 with jitter), then a drift (pan translation
// grows while the pinch factor holds). The layer point under the focal must
// stay under the focal while spreading, and follow the fingers while drifting.
{
  const MIN = 0.5, MAX = 12;
  // v6 model (from MapViewer): one base, two terms, one apply().
  const mk = () => ({ tx: 0, ty: 0, scale: s0, fitScale: s0, bTx: 0, bTy: 0, bS: s0, fx: 0, fy: 0, pinch: 1, panX: 0, panY: 0, rawX: 0, rawY: 0, offX: 0, offY: 0 });
  const rebase = (g, fx, fy) => { g.bTx = g.tx; g.bTy = g.ty; g.bS = g.scale; g.fx = fx; g.fy = fy; g.pinch = 1; g.panX = 0; g.panY = 0; g.offX = g.rawX; g.offY = g.rawY; };
  const apply = (g) => {
    const next = Math.max(g.fitScale * MIN, Math.min(g.fitScale * MAX, g.bS * g.pinch));
    const k = next / g.bS;
    g.tx = g.fx - (g.fx - g.bTx) * k + g.panX;
    g.ty = g.fy - (g.fy - g.bTy) * k + g.panY;
    g.scale = next;
  };
  const panStart = (g) => { g.rawX = 0; g.rawY = 0; rebase(g, g.fx, g.fy); };
  const panUpdate = (g, dx, dy) => { g.rawX = dx; g.rawY = dy; g.panX = dx - g.offX; g.panY = dy - g.offY; apply(g); };
  const panEnd = (g) => { rebase(g, g.fx, g.fy); g.rawX = g.rawY = g.offX = g.offY = 0; };
  const pinchStart = (g, fx, fy) => rebase(g, fx, fy);
  const pinchUpdate = (g, e) => { g.pinch = e; apply(g); };
  const pinchEnd = (g) => rebase(g, g.fx, g.fy);

  // v5 model (the bug): each handler owns tx/ty from its private start state.
  const mk5 = () => ({ tx: 0, ty: 0, scale: s0, startX: 0, startY: 0, startS: s0, fx: 0, fy: 0 });
  const v5 = {
    panStart: (g) => { g.startX = g.tx; g.startY = g.ty; },
    panUpdate: (g, dx, dy) => { g.tx = g.startX + dx; g.ty = g.startY + dy; },
    pinchStart: (g, fx, fy) => { g.startS = g.scale; g.fx = fx; g.fy = fy; },
    pinchUpdate: (g, e) => { const next = Math.max(s0 * MIN, Math.min(s0 * MAX, g.startS * e)); const dz = next / g.scale; g.tx = g.fx - (g.fx - g.tx) * dz; g.ty = g.fy - (g.fy - g.ty) * dz; g.scale = next; },
  };

  const fitted = (g) => { g.tx = (vp.w - render.w * s0) / 2; g.ty = (vp.h - render.h * s0) / 2; g.scale = s0; };
  const run = (model, isV5) => {
    const g = isV5 ? mk5() : mk(); fitted(g);
    const F = [540, 1100];                                   // fingers' midpoint
    const under = [(F[0] - g.tx) / g.scale, (F[1] - g.ty) / g.scale];  // layer pt under fingers
    // Sequence RNGH produces: pan activates first (2 pointers, tiny translation), then pinch.
    (isV5 ? v5.panStart : panStart)(g);
    (isV5 ? v5.pinchStart : pinchStart)(g, F[0], F[1]);
    let worst = 0;
    // phase 1: spread — 40 frames, scale 1 -> 3, pan jitter ±2px, both handlers each frame
    for (let i = 1; i <= 40; i++) {
      const e = 1 + (2 * i) / 40, jx = 2 * Math.sin(i), jy = 2 * Math.cos(i);
      (isV5 ? v5.pinchUpdate : pinchUpdate)(g, e);
      (isV5 ? v5.panUpdate : panUpdate)(g, jx, jy);
      const now = [g.tx + g.scale * under[0], g.ty + g.scale * under[1]];
      worst = Math.max(worst, Math.hypot(now[0] - (F[0] + jx), now[1] - (F[1] + jy)));
    }
    // phase 2: drift — fingers move 150px right, 80px down at constant spread
    for (let i = 1; i <= 30; i++) {
      const dx = 2 * Math.sin(40) + 150 * i / 30, dy = 2 * Math.cos(40) + 80 * i / 30;
      (isV5 ? v5.pinchUpdate : pinchUpdate)(g, 3);
      (isV5 ? v5.panUpdate : panUpdate)(g, dx, dy);
      const now = [g.tx + g.scale * under[0], g.ty + g.scale * under[1]];
      worst = Math.max(worst, Math.hypot(now[0] - (F[0] + dx), now[1] - (F[1] + dy)));
    }
    if (!isV5) { pinchEnd(g); panEnd(g); }
    return { worst, g };
  };
  const good = run(null, false);
  const bad = run(null, true);
  ok(good.worst < 1e-6, `concurrent pan+pinch: point under fingers drifted ${good.worst.toFixed(1)}px (must be 0)`);
  ok(bad.worst > 100, `gate self-check: the v5 handler model should drift badly (got ${bad.worst.toFixed(0)}px) — if this passes the test is toothless`);
  ok(Math.abs(good.g.scale - 3 * s0) < 1e-9, 'concurrent gesture ended at the wrong scale');
  // After both end, a plain pan continues from the current view with no jump.
  const g = good.g; const before = [g.tx, g.ty];
  panStart(g); panUpdate(g, 0, 0);
  ok(Math.abs(g.tx - before[0]) < 1e-9 && Math.abs(g.ty - before[1]) < 1e-9, 'view jumped when a new pan started after a pinch');
  // A pinch that starts mid-pan (second finger lands) must not jump either.
  panUpdate(g, 37, -12); const mid = [g.tx, g.ty, g.scale];
  pinchStart(g, 200, 300); pinchUpdate(g, 1); panUpdate(g, 37, -12);
  ok(Math.abs(g.tx - mid[0]) < 1e-9 && Math.abs(g.ty - mid[1]) < 1e-9 && g.scale === mid[2], 'view jumped when a pinch started mid-pan');
  const pinchModelInSource = /gPinch\.value = e\.scale;\s*apply\(\);/.test(readFileSync(new URL('../components/MapViewer.tsx', import.meta.url), 'utf8'));
  ok(pinchModelInSource, 'MapViewer pinch handler does not use the unified apply() model');
  // The concurrent model above assumes pan translation = midpoint motion. RNGH
  // only does that with averageTouches(true); its default tracks the last pointer.
  ok(/Gesture\.Pan\(\)[\s\S]{0,600}\.averageTouches\(true\)/.test(readFileSync(new URL('../components/MapViewer.tsx', import.meta.url), 'utf8')), 'Pan must use averageTouches(true) or a symmetric pinch pans the map');
  ok(!/tx\.value = startX\.value \+ e\.translationX/.test(readFileSync(new URL('../components/MapViewer.tsx', import.meta.url), 'utf8')), 'the v5 pan handler (private start state) is back');
}

const src = readFileSync(new URL('../components/MapViewer.tsx', import.meta.url), 'utf8');
ok(/transformOrigin:\s*'top left'/.test(src), "map layer lacks transformOrigin 'top left'");
ok(!/\(\s*vw\.value\s*\/\s*2\s*\)\s*\*\s*\(1\s*-\s*scale\.value\)/.test(src), 'center-pivot compensation term is back (the drift bug)');
ok(!/minScale=\{1\}[\s\S]{0,400}fit\.base/.test(src) && !/fit\.base/.test(src), 'nested inner fit scale is back');

if (fails.length) { console.error('✗ GEOMETRY GATE FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
console.log('✓ GEOMETRY GATE PASSED (fit centered, pinch focal fixed, CONCURRENT pan+pinch stable, overlay==transform, inverse exact, single top-left transform)');

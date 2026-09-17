import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image, LayoutChangeEvent, PixelRatio, StyleSheet, Text, View } from 'react-native';
import * as FileSystem from 'expo-file-system';
import Svg, { Circle, Polygon, Polyline, Text as SvgText } from 'react-native-svg';
import Animated, {
  runOnJS,
  SharedValue,
  useAnimatedProps,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { GeoRef, latLonToPage, metersToPagePx, pageToLatLon } from '../lib/geopdf';
import { Pin, TrackPoint } from '../lib/storage';
import { niceScale, ScaleBar } from '../lib/grid';
import { renderPage, renderRegion, RenderedPage } from '../modules/pdf-page';

interface Props {
  fileUri: string;
  geo: GeoRef | null;
  location: { latitude: number; longitude: number; accuracy: number | null } | null;
  pins: Pin[];
  trace: TrackPoint[];
  onDropPin: (lat: number, lon: number) => void;
  onTapPin: (index: number) => void;
  /** Bumped by the parent's "Fit" button to recenter on demand (never automatic). */
  fitRequest?: number;
  /** Compass heading, degrees true (null = unknown). Drawn as an arrow on the dot. */
  heading?: number | null;
  /** Keep the map centred on the GPS dot; any user pan/pinch reports back via onUserGesture. */
  follow?: boolean;
  onUserGesture?: () => void;
  /** Measure mode: taps append points instead of hitting pins. */
  measureMode?: boolean;
  measurePts?: { lat: number; lon: number }[];
  onMeasureTap?: (lat: number, lon: number) => void;
  measureLabel?: string;
}

// GEOMETRY — one transform, one origin, no nesting.
//
// The map layer is a single Animated.View laid out at the FULL render size
// (render.w x render.h, the page's natural pixels) with transformOrigin at its
// top-left. There is exactly one mapping, shared by everything:
//
//     screen = (tx, ty) + scale * layer          (layer origin = top-left)
//
// "Fitted to the screen" is not a separate inner scale — it is just the initial
// {tx, ty, scale} that makes the whole page fit. So the fitted view and a zoomed
// view are the same math, and the overlay, the pinch focal point, taps and
// long-presses all use the identical formula with NO compensation terms.
//
// The previous version nested two scales (an outer zoom on a viewport-sized
// view, plus an inner "fit" scale on a page-sized box) and then guessed at the
// composed pivot with a (vw/2)*(1-s) term. The pivot of the *outer* view is the
// viewport center; the inner box was scaled about *its* center; the guess was
// wrong for both, and the error grew with zoom. That is why zooming drifted to
// a corner, the dot flew, and zoom-out misbehaved. transformOrigin removes the
// pivot question entirely.
//
// RENDERING: no PDF *viewer* widget. react-native-pdf is a native view with its
// own gesture handling and its own zoom-dependent tile resolution; wrapping it
// in this transform only magnified whatever 1x bitmap it had chosen to draw,
// so zoom fought the outer gestures and stayed blurry. Instead the local
// modules/pdf-page module (Android's built-in PdfRenderer, no third-party code)
// hands back plain bitmaps and ordinary <Image>s show them:
//
//   BASE  - the whole page once, long edge <= BASE_MAX_PX. Bounded memory, always
//           present, sharp at the fitted zoom.
//   TILE  - after every gesture ends, the VISIBLE page rectangle re-rendered at
//           the screen's real pixel density and placed at its layer coordinates
//           on top of the base. Vector text is re-rasterized for the current
//           zoom instead of a bitmap being stretched. Constant memory (about a
//           viewport's worth of pixels) at any zoom.
//
// OVERLAY: a fixed VIEWPORT-sized <Svg> outside the transform. react-native-svg
// rasterizes its whole view into one bitmap in onDraw; a page-sized overlay
// (3456x2592 dp at 2.75x density = 271 MB) exceeds Android's ~100 MB limit and
// crashes. Viewport-sized (~9 MB) it is always safe. Its contents are projected
// into screen space each frame from the same shared values as the map.
//
// STICKY VIEW: pan/pinch write to shared values that survive re-renders. Only
// an explicit fitRequest resets them. GPS updates move only the overlay.

// Layer size in dp: the page's point size, capped. Only a coordinate space — no
// bitmap is this size. (Pixels come from BASE_MAX_PX / the tile, below.)
const MAX_RENDER_EDGE_DP = 4096;
// Base bitmap long edge in PIXELS. 4096 x 3072 x 4 B = 48 MB decoded — under
// Android's ~100 MB single-bitmap draw limit with margin on every device.
const BASE_MAX_PX = 4096;
// Sharp tile budget: viewport-ish (1080x2400x4 = 10 MB) plus margin, hard-capped.
const MAX_TILE_BYTES = 32 * 1024 * 1024;
// Render a little beyond the viewport so small pans stay sharp without re-rendering.
const TILE_MARGIN = 0.15;
// Only bother with a tile when the base bitmap is being magnified past ~1:1.
const TILE_WHEN_MAGNIFIED_BY = 1.05;
const MIN_SCALE_FACTOR = 0.5; // relative to the fitted scale
const MAX_SCALE_FACTOR = 12;

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedPolyline = Animated.createAnimatedComponent(Polyline);

type XF = { tx: SharedValue<number>; ty: SharedValue<number>; scale: SharedValue<number> };

/** A circle at layer point (lx,ly), projected to the screen each frame.
 *  `r` is a constant screen radius; `rLayer` is a radius in layer units that
 *  scales with zoom (used for the GPS accuracy ring). */
function ScreenCircle({
  lx, ly, r, rLayer, xf, fill, stroke, strokeWidth, opacity,
}: {
  lx: number; ly: number; r?: number; rLayer?: number; xf: XF;
  fill?: string; stroke?: string; strokeWidth?: number; opacity?: number;
}) {
  const animatedProps = useAnimatedProps(() => ({
    cx: xf.tx.value + xf.scale.value * lx,
    cy: xf.ty.value + xf.scale.value * ly,
    r: rLayer !== undefined ? rLayer * xf.scale.value : (r ?? 6),
  }));
  return (
    <AnimatedCircle
      animatedProps={animatedProps as any}
      fill={fill}
      stroke={stroke}
      strokeWidth={strokeWidth}
      opacity={opacity}
    />
  );
}

/** The recorded trace: layer points (flat [x0,y0,x1,y1,...]) projected each frame. */
function ScreenPolyline({ layerPts, xf, stroke = '#f97316', dashed = false }: { layerPts: number[]; xf: XF; stroke?: string; dashed?: boolean }) {
  const animatedProps = useAnimatedProps(() => {
    const s = xf.scale.value;
    const x0 = xf.tx.value;
    const y0 = xf.ty.value;
    let out = '';
    for (let i = 0; i + 1 < layerPts.length; i += 2) {
      out += `${x0 + s * layerPts[i]},${y0 + s * layerPts[i + 1]} `;
    }
    return { points: out };
  });
  return (
    <AnimatedPolyline
      animatedProps={animatedProps as any}
      fill="none"
      stroke={stroke}
      strokeWidth={4}
      strokeDasharray={dashed ? '10 8' : undefined}
      strokeLinejoin="round"
      strokeLinecap="round"
      opacity={0.9}
    />
  );
}

const AnimatedPolygon = Animated.createAnimatedComponent(Polygon);
const AnimatedSvgText = Animated.createAnimatedComponent(SvgText);

/** Heading arrow: a triangle just outside the dot, pointing along `heading`
 *  (degrees true, screen-up = north — GeoPDF fire maps are north-up). */
function ScreenHeading({ lx, ly, heading, xf }: { lx: number; ly: number; heading: SharedValue<number>; xf: XF }) {
  const animatedProps = useAnimatedProps(() => {
    const h = heading.value;
    if (!(h >= 0)) return { points: '' };
    const cx = xf.tx.value + xf.scale.value * lx;
    const cy = xf.ty.value + xf.scale.value * ly;
    const t = (h * Math.PI) / 180;
    const dx = Math.sin(t), dy = -Math.cos(t);     // unit vector along heading
    const px = -dy, py = dx;                        // perpendicular
    const tipX = cx + 38 * dx, tipY = cy + 38 * dy;
    const bX = cx + 16 * dx, bY = cy + 16 * dy;
    return { points: `${tipX},${tipY} ${bX + 9 * px},${bY + 9 * py} ${bX - 9 * px},${bY - 9 * py}` };
  });
  return <AnimatedPolygon animatedProps={animatedProps as any} fill="#2563eb" stroke="#fff" strokeWidth={2} />;
}

/** A text label anchored at a layer point with a constant screen offset. */
function ScreenText({ lx, ly, xf, text, dx = 12, dy = -12, fill = '#fff', size = 13 }: {
  lx: number; ly: number; xf: XF; text: string; dx?: number; dy?: number; fill?: string; size?: number;
}) {
  const animatedProps = useAnimatedProps(() => ({
    x: xf.tx.value + xf.scale.value * lx + dx,
    y: xf.ty.value + xf.scale.value * ly + dy,
  }));
  // Halo: a black stroked copy underneath, the coloured fill on top (react-native-svg
  // has no paint-order, so two texts).
  return (
    <>
      <AnimatedSvgText animatedProps={animatedProps as any} fill="#000" stroke="#000" strokeWidth={4} fontSize={size} fontWeight="bold">
        {text}
      </AnimatedSvgText>
      <AnimatedSvgText animatedProps={animatedProps as any} fill={fill} fontSize={size} fontWeight="bold">
        {text}
      </AnimatedSvgText>
    </>
  );
}

export default function MapViewer({
  fileUri, geo, location, pins, trace, onDropPin, onTapPin, fitRequest,
  heading = null, follow = false, onUserGesture, measureMode = false, measurePts = [], onMeasureTap, measureLabel,
}: Props) {
  // Heading lives in a shared value so the arrow rotates on the UI thread.
  const headingSV = useSharedValue(-1);
  useEffect(() => { headingSV.value = heading === null || heading === undefined || Number.isNaN(heading) ? -1 : heading; }, [heading, headingSV]);
  const [scaleBar, setScaleBar] = useState<ScaleBar | null>(null);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [base, setBase] = useState<RenderedPage | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  type Tile = { uri: string; lx: number; ly: number; lw: number; lh: number };
  const [tile, setTile] = useState<Tile | null>(null);
  const tileReq = useRef(0);
  // Long-press = one finger, still, 450 ms. Driven by the pan's own touch
  // lifecycle instead of RNGH's LongPress handler: that handler, composed with
  // pan/pinch, either fought them (Simultaneous: stray pins during a slow
  // pinch) or beat them (Race: a thumb resting 450 ms before a spread dropped
  // a pin and cancelled the zoom). Cancelled by movement, a second finger, or lift.
  const lpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Small on-screen diagnostics so a field report can say exactly what the
  // renderer did ("zoom 4.2x · tile 2880x1600 in 210 ms" / an error).
  const [status, setStatus] = useState('');
  const tileTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Render page 1 once per file. Everything else in this component is geometry.
  useEffect(() => {
    let alive = true;
    setBase(null); setTile(null); setRenderError(null);
    renderPage(fileUri, 0, BASE_MAX_PX, BASE_MAX_PX)
      .then((r) => { if (alive) setBase(r); })
      .catch((e) => { if (alive) setRenderError(String(e?.message ?? e)); });
    return () => { alive = false; };
  }, [fileUri]);

  // The one persistent user transform. screen = (tx,ty) + scale * layer, origin top-left.
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const scale = useSharedValue(1);
  // Fitted scale, so pinch limits are relative to "whole page on screen".
  const fitScale = useSharedValue(1);
  // ONE gesture model shared by pan and pinch (they run Simultaneous, so during a
  // two-finger pinch BOTH handlers fire every frame). Each gesture contributes
  // its own term and a single apply() recomputes the transform from a common
  // base; neither handler ever writes tx/ty/scale from its own private start
  // state. (v5 bug: Pan wrote tx = startX + translation on every frame, wiping
  // out Pinch's focal compensation, so zoom expanded from the top-left corner.)
  // Until the user touches the map, layout changes (status bar / nav inset
  // settling after first paint) re-fit; afterwards the view is theirs.
  const interacted = useSharedValue(false);
  const gBaseTx = useSharedValue(0);
  const gBaseTy = useSharedValue(0);
  const gBaseScale = useSharedValue(1);
  const gFocalX = useSharedValue(0);      // pinch anchor (screen px) at rebase
  const gFocalY = useSharedValue(0);
  const gPinch = useSharedValue(1);       // pinch factor since rebase
  const gPanX = useSharedValue(0);        // pan delta since rebase
  const gPanY = useSharedValue(0);
  const gPanRawX = useSharedValue(0);     // pan's cumulative translation (its own frame)
  const gPanRawY = useSharedValue(0);
  const gPanOffX = useSharedValue(0);     // pan raw at the last rebase
  const gPanOffY = useSharedValue(0);
  const xf = useMemo<XF>(() => ({ tx, ty, scale }), [tx, ty, scale]);

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setViewport({ w: width, h: height });
  };

  const media = useMemo(() => {
    if (geo && geo.mediaWidth && geo.mediaHeight) return { w: geo.mediaWidth, h: geo.mediaHeight };
    if (base) return { w: base.pageWidth, h: base.pageHeight };
    return null;
  }, [geo, base]);

  // The layer box (dp): the page's point size, capped by edge length. `q` is the
  // page-pt -> layer-dp factor used by every lat/lon projection. Pure geometry;
  // the base bitmap is stretched into this box and its pixel size is separate.
  const render = useMemo(() => {
    if (!media) return null;
    const longEdge = Math.max(media.w, media.h);
    const q = Math.min(1, MAX_RENDER_EDGE_DP / longEdge);
    return { w: Math.round(media.w * q), h: Math.round(media.h * q), q };
  }, [media]);

  // The fitted transform: whole page contained in the viewport, centered.
  const fit = useMemo(() => {
    if (!render || !viewport.w || !viewport.h) return null;
    const s = Math.min(viewport.w / render.w, viewport.h / render.h);
    return {
      scale: s,
      tx: (viewport.w - render.w * s) / 2,
      ty: (viewport.h - render.h * s) / 2,
    };
  }, [render, viewport]);

  // Apply the fitted transform when the map first becomes ready, and on explicit
  // fit requests. NEVER on GPS updates or re-renders.
  const fitKey = fit ? `${fit.scale}|${fit.tx}|${fit.ty}` : '';
  useEffect(() => {
    if (!fit) return;
    fitScale.value = fit.scale;
    // Fit on first readiness and on any layout change BEFORE the user has
    // touched the map (the first onLayout can be 60+ px taller than the settled
    // viewport, which left the initial fit visibly off-centre). Once the user
    // has interacted, layout changes leave their view alone.
    if (!interacted.value) {
      scale.value = fit.scale;
      tx.value = fit.tx;
      ty.value = fit.ty;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  useEffect(() => {
    if (fitRequest === undefined || !fit) return;
    scale.value = fit.scale;
    tx.value = fit.tx;
    ty.value = fit.ty;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitRequest]);

  // lat/lon -> LAYER px. The layer IS the render box, so this is just page->render.
  const toLayer = (lat: number, lon: number): [number, number] | null => {
    if (!geo || !render) return null;
    const [px, py] = latLonToPage(geo, lat, lon);
    return [px * render.q, py * render.q];
  };

  // viewport px -> lat/lon (long-press pin drop): invert screen = t + s*layer.
  const handleLongPress = (vx: number, vy: number) => {
    if (!geo || !render) return;
    const lx = (vx - tx.value) / scale.value;
    const ly = (vy - ty.value) / scale.value;
    const [lat, lon] = pageToLatLon(geo, lx / render.q, ly / render.q);
    onDropPin(lat, lon);
  };

  // Tap: in measure mode append a point; otherwise hit-test pins (parent decides what to do).
  const handleTap = (vx: number, vy: number) => {
    if (measureMode) {
      if (!geo || !render || !onMeasureTap) return;
      const lx = (vx - tx.value) / scale.value;
      const ly = (vy - ty.value) / scale.value;
      const [lat, lon] = pageToLatLon(geo, lx / render.q, ly / render.q);
      onMeasureTap(lat, lon);
      return;
    }
    let best = -1;
    let bestD = 28;
    for (let i = 0; i < pins.length; i++) {
      const L = toLayer(pins[i].lat, pins[i].lon);
      if (!L) continue;
      const d = Math.hypot(tx.value + scale.value * L[0] - vx, ty.value + scale.value * L[1] - vy);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0) onTapPin(best);
  };

  // --- follow-me: keep the dot at the viewport centre at the current zoom ---
  const followKey = follow && location ? `${location.latitude},${location.longitude}` : '';
  useEffect(() => {
    if (!follow || !location || !render || !viewport.w) return;
    const L = toLayer(location.latitude, location.longitude);
    if (!L) return;
    tx.value = viewport.w / 2 - scale.value * L[0];
    ty.value = viewport.h / 2 - scale.value * L[1];
    requestTileRef.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followKey, follow, render, viewport]);

  // --- scale bar: recomputed from the live zoom on every frame, cheap ---
  const metersPerLayerDp = useMemo(() => {
    if (!geo || !render) return 0;
    const pagePxPerMeter = metersToPagePx(geo, 1);
    return pagePxPerMeter > 0 ? 1 / (pagePxPerMeter * render.q) : 0;
  }, [geo, render]);
  const updateScaleBar = (s: number) => {
    if (!metersPerLayerDp) { setScaleBar(null); return; }
    const sb = niceScale(metersPerLayerDp / s, 140);
    setScaleBar((prev) => (prev && sb && prev.label === sb.label && Math.abs(prev.px - sb.px) < 1 ? prev : sb));
  };
  useAnimatedReaction(() => scale.value, (s, prev) => { if (s !== prev) runOnJS(updateScaleBar)(s); }, [metersPerLayerDp]);
  useEffect(() => { updateScaleBar(scale.value); }, [metersPerLayerDp]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- sharp tile: re-render the visible page rect at screen density (JS thread) ---
  const oldTileUris = useRef<string[]>([]);
  const dropTileFile = (uri: string) => {
    // Defer so an <Image> that is mid-decode of the old file is never yanked.
    setTimeout(() => { FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {}); }, 1500);
  };
  const requestTile = useCallback(() => {
    if (tileTimer.current) clearTimeout(tileTimer.current);
    tileTimer.current = setTimeout(async () => {
      if (!base || !render || !viewport.w || !viewport.h) return;
      const s = scale.value;
      const x = tx.value;
      const y = ty.value;
      const density = PixelRatio.get();
      // Base bitmap pixels per layer dp vs screen pixels per layer dp.
      const basePxPerDp = base.width / render.w;
      const zoomX = (s / fitScale.value).toFixed(1);
      if (s * density <= basePxPerDp * TILE_WHEN_MAGNIFIED_BY) {
        // Zoomed out: the base is already >= 1:1 on screen. No tile needed.
        tileReq.current++;
        setTile((prev) => { if (prev) dropTileFile(prev.uri); return null; });
        setStatus(`zoom ${zoomX}x · base ${base.width}x${base.height}`);
        return;
      }
      // Visible layer rect (inverse of screen = t + s*layer), padded, clipped to the page.
      const vw = viewport.w / s;
      const vh = viewport.h / s;
      let lx0 = (0 - x) / s - vw * TILE_MARGIN;
      let ly0 = (0 - y) / s - vh * TILE_MARGIN;
      let lx1 = (viewport.w - x) / s + vw * TILE_MARGIN;
      let ly1 = (viewport.h - y) / s + vh * TILE_MARGIN;
      lx0 = Math.max(0, lx0); ly0 = Math.max(0, ly0);
      lx1 = Math.min(render.w, lx1); ly1 = Math.min(render.h, ly1);
      if (lx1 - lx0 < 1 || ly1 - ly0 < 1) return;
      // Output pixels: exactly what the screen shows for that rect, capped by budget.
      let pxW = (lx1 - lx0) * s * density;
      let pxH = (ly1 - ly0) * s * density;
      const over = Math.sqrt(MAX_TILE_BYTES / (pxW * pxH * 4));
      if (over < 1) { pxW *= over; pxH *= over; }
      // Layer dp -> renderer page points (the renderer's own page size, not geo's).
      const kx = base.pageWidth / render.w;
      const ky = base.pageHeight / render.h;
      const id = ++tileReq.current;
      const t0 = Date.now();
      setStatus(`zoom ${zoomX}x · rendering ${Math.round(pxW)}x${Math.round(pxH)}…`);
      try {
        const r = await renderRegion(fileUri, 0, lx0 * kx, ly0 * ky, lx1 * kx, ly1 * ky, pxW, pxH);
        if (id !== tileReq.current) { dropTileFile(r.uri); return; } // superseded
        setTile((prev) => {
          if (prev) dropTileFile(prev.uri);
          return { uri: r.uri, lx: lx0, ly: ly0, lw: lx1 - lx0, lh: ly1 - ly0 };
        });
        setStatus(`zoom ${zoomX}x · tile ${r.width}x${r.height} in ${Date.now() - t0} ms`);
      } catch (e: any) {
        // The base is still on screen; say why it is not sharp.
        setStatus(`zoom ${zoomX}x · tile FAILED: ${String(e?.message ?? e).slice(0, 80)}`);
      }
    }, 120);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, render, viewport, fileUri]);

  const requestTileRef = useRef<(() => void) | null>(null);
  requestTileRef.current = requestTile;
  // A fresh base (new file / first render) invalidates any tile; refit triggers a tile check.
  useEffect(() => { requestTile(); }, [requestTile, fitRequest]);

  // Rebase: the current transform becomes the base; both gesture terms reset.
  // Called whenever a gesture starts or ends so the other one continues from
  // exactly where the view is now.
  const rebase = (fx: number, fy: number) => {
    'worklet';
    gBaseTx.value = tx.value;
    gBaseTy.value = ty.value;
    gBaseScale.value = scale.value;
    gFocalX.value = fx;
    gFocalY.value = fy;
    gPinch.value = 1;
    gPanX.value = 0;
    gPanY.value = 0;
    gPanOffX.value = gPanRawX.value;
    gPanOffY.value = gPanRawY.value;
  };
  // screen = t + s*layer. Scale about the anchor by k, then add the pan delta:
  //   t = anchor - (anchor - baseT) * k + pan
  const apply = () => {
    'worklet';
    const lo = fitScale.value * MIN_SCALE_FACTOR;
    const hi = fitScale.value * MAX_SCALE_FACTOR;
    const next = Math.max(lo, Math.min(hi, gBaseScale.value * gPinch.value));
    const k = next / gBaseScale.value;
    tx.value = gFocalX.value - (gFocalX.value - gBaseTx.value) * k + gPanX.value;
    ty.value = gFocalY.value - (gFocalY.value - gBaseTy.value) * k + gPanY.value;
    scale.value = next;
  };

  const lpArm = (x: number, y: number) => {
    if (lpTimer.current) clearTimeout(lpTimer.current);
    lpTimer.current = setTimeout(() => { lpTimer.current = null; handleLongPress(x, y); }, 450);
  };
  const lpCancel = () => {
    if (lpTimer.current) { clearTimeout(lpTimer.current); lpTimer.current = null; }
  };

  const pan = Gesture.Pan()
    .minDistance(4)
    .onBegin((e) => { interacted.value = true; runOnJS(lpArm)(e.x, e.y); })
    .onTouchesDown((e) => { if (e.numberOfTouches > 1) runOnJS(lpCancel)(); })
    .onTouchesMove((e) => { if (e.numberOfTouches > 1) runOnJS(lpCancel)(); })
    .onFinalize(() => { runOnJS(lpCancel)(); })
    // Track the fingers' MIDPOINT. RNGH's default follows the last-added
    // pointer, so a symmetric two-finger spread reads as a ~half-spread pan and
    // the map slides toward a corner while zooming (the v4/v5 symptom, caught
    // on the emulator with synthetic two-finger input).
    .averageTouches(true)
    .onStart(() => {
      runOnJS(lpCancel)();
      if (onUserGesture) runOnJS(onUserGesture)(); // a real pan turns follow-me off
      gPanRawX.value = 0;
      gPanRawY.value = 0;
      rebase(gFocalX.value, gFocalY.value);
    })
    .onUpdate((e) => {
      gPanRawX.value = e.translationX;
      gPanRawY.value = e.translationY;
      gPanX.value = e.translationX - gPanOffX.value;
      gPanY.value = e.translationY - gPanOffY.value;
      apply();
    })
    .onEnd(() => {
      rebase(gFocalX.value, gFocalY.value);
      gPanRawX.value = 0;
      gPanRawY.value = 0;
      gPanOffX.value = 0;
      gPanOffY.value = 0;
      runOnJS(requestTile)();
    });

  const pinch = Gesture.Pinch()
    .onBegin(() => { interacted.value = true; if (onUserGesture) runOnJS(onUserGesture)(); })
    .onStart((e) => {
      // Anchor at the fingers' midpoint. Any pan already in progress is folded
      // into the base by rebase(), so its later deltas start from zero here.
      rebase(e.focalX, e.focalY);
    })
    .onUpdate((e) => {
      gPinch.value = e.scale;
      apply();
    })
    .onEnd(() => {
      rebase(gFocalX.value, gFocalY.value);
      runOnJS(requestTile)();
    });

  const tap = Gesture.Tap().maxDistance(12).onEnd((e) => {
    runOnJS(handleTap)(e.x, e.y);
  });
  // Pan+pinch run together (two-finger zoom while dragging); a tap races them
  // (any movement fails the tap; a clean touch-up wins it). Long-press is the
  // timer above, not a handler, so nothing can cancel a zoom.
  const composed = Gesture.Race(Gesture.Simultaneous(pan, pinch), tap);

  // The single map transform. transformOrigin top-left makes screen = t + s*layer
  // literally true — no center-pivot compensation.
  const layerStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: tx.value },
      { translateY: ty.value },
      { scale: scale.value },
    ],
  }));

  // --- overlay geometry in LAYER space (cheap; projected per-frame in worklets) ---
  const dot = useMemo(() => {
    if (!location) return null;
    const L = toLayer(location.latitude, location.longitude);
    if (!L || !geo || !render) return null;
    const accM = location.accuracy && location.accuracy > 0 ? location.accuracy : 0;
    const accLayer = accM ? metersToPagePx(geo, accM) * render.q : 0;
    return { lx: L[0], ly: L[1], accLayer };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo, location, render]);

  const traceLayer = useMemo(() => {
    const out: number[] = [];
    for (const p of trace) {
      const L = toLayer(p.lat, p.lon);
      if (L) out.push(L[0], L[1]);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trace, geo, render]);

  const pinLayer = useMemo(
    () => pins.map((p) => toLayer(p.lat, p.lon)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pins, geo, render],
  );
  const measureLayer = useMemo(
    () => measurePts.map((p) => toLayer(p.lat, p.lon)).filter((L): L is [number, number] => !!L),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [measurePts, geo, render],
  );
  const measureFlat = useMemo(() => measureLayer.flatMap((L) => [L[0], L[1]]), [measureLayer]);

  return (
    <View style={styles.fill} onLayout={onLayout}>
      <GestureDetector gesture={composed}>
        {/* Gesture surface = the whole viewport, so pans start anywhere. */}
        <Animated.View style={styles.fill}>
          {render && (
            <Animated.View
              style={[
                {
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  width: render.w,
                  height: render.h,
                  transformOrigin: 'top left',
                },
                layerStyle,
              ]}
            >
              {/* BASE: whole page, bounded pixels, stretched into the layer box. */}
              {base && (
                <Image
                  source={{ uri: base.uri }}
                  style={{ position: 'absolute', left: 0, top: 0, width: render.w, height: render.h }}
                  resizeMode="stretch"
                  // "auto" lets Fresco downsample file:// sources to the LAYOUT size, which
                  // is the unscaled dp box — that would throw away the tile's extra pixels.
                  resizeMethod="scale"
                  fadeDuration={0}
                />
              )}
              {/* TILE: the visible rect at screen density, in layer coordinates. */}
              {tile && (
                <Image
                  source={{ uri: tile.uri }}
                  style={{ position: 'absolute', left: tile.lx, top: tile.ly, width: tile.lw, height: tile.lh }}
                  resizeMode="stretch"
                  // "auto" lets Fresco downsample file:// sources to the LAYOUT size, which
                  // is the unscaled dp box — that would throw away the tile's extra pixels.
                  resizeMethod="scale"
                  fadeDuration={0}
                />
              )}
            </Animated.View>
          )}
        </Animated.View>
      </GestureDetector>

      {/* OVERLAY: fixed VIEWPORT size, outside the transform. Never page-sized. */}
      {fit && viewport.w > 0 && (
        <Svg
          style={StyleSheet.absoluteFill}
          width={viewport.w}
          height={viewport.h}
          pointerEvents="none"
        >
          {traceLayer.length >= 4 && <ScreenPolyline layerPts={traceLayer} xf={xf} />}
          {measureFlat.length >= 4 && <ScreenPolyline layerPts={measureFlat} xf={xf} stroke="#22d3ee" dashed />}
          {measureLayer.map((L, i) => (
            <ScreenCircle key={`m${i}`} lx={L[0]} ly={L[1]} r={6} xf={xf} fill="#22d3ee" stroke="#000" strokeWidth={1.5} />
          ))}
          {measureLayer.length >= 2 && measureLabel && (
            <ScreenText lx={measureLayer[measureLayer.length - 1][0]} ly={measureLayer[measureLayer.length - 1][1]} xf={xf} text={measureLabel} fill="#a5f3fc" />
          )}
          {pinLayer.map((L, i) =>
            L ? (
              <React.Fragment key={i}>
                <ScreenCircle lx={L[0]} ly={L[1]} r={9} xf={xf} fill="#dc2626" stroke="#fff" strokeWidth={2.5} />
                <ScreenCircle lx={L[0]} ly={L[1]} r={2.5} xf={xf} fill="#fff" />
                {pins[i].label ? <ScreenText lx={L[0]} ly={L[1]} xf={xf} text={pins[i].label as string} /> : null}
              </React.Fragment>
            ) : null,
          )}
          {dot && dot.accLayer > 0 && (
            <ScreenCircle
              lx={dot.lx} ly={dot.ly} rLayer={dot.accLayer} xf={xf}
              fill="rgba(37,99,235,0.12)" stroke="rgba(37,99,235,0.35)" strokeWidth={1.5}
            />
          )}
          {dot && (
            <>
              <ScreenCircle lx={dot.lx} ly={dot.ly} r={16} xf={xf} fill="rgba(37,99,235,0.18)" />
              <ScreenCircle lx={dot.lx} ly={dot.ly} r={7} xf={xf} fill="#2563eb" stroke="#fff" strokeWidth={2.5} />
              <ScreenHeading lx={dot.lx} ly={dot.ly} heading={headingSV} xf={xf} />
            </>
          )}
        </Svg>
      )}

      {scaleBar && (
        <View style={[styles.scaleBox, { width: scaleBar.px + 16 }]} pointerEvents="none">
          <Text style={styles.scaleLabel}>{scaleBar.label}  <Text style={styles.scaleMetric}>{scaleBar.metric}</Text></Text>
          <View style={[styles.scaleLine, { width: scaleBar.px }]}>
            <View style={styles.scaleTick} /><View style={styles.scaleTick} />
          </View>
        </View>
      )}
      {!!status && (
        <View style={styles.statusBox} pointerEvents="none">
          <Text style={styles.statusText}>{status}</Text>
        </View>
      )}

      {(!fit || !base) && (
        <View style={styles.center} pointerEvents="none">
          <Text style={styles.hint}>{renderError ? `Could not render this PDF: ${renderError}` : 'Rendering map…'}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, width: '100%', height: '100%' },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  hint: { color: '#aaa', fontSize: 14 },
  // Both sit just above the parent's control pills (2 rows + tip ≈ 130 dp).
  scaleBox: { position: 'absolute', right: 8, bottom: 134, alignItems: 'flex-end', minWidth: 90 },
  scaleLabel: { color: '#fff', fontSize: 12, fontWeight: '700', textShadowColor: '#000', textShadowRadius: 3 },
  scaleMetric: { color: '#cbd5e1', fontSize: 10, fontWeight: '500' },
  scaleLine: { height: 3, backgroundColor: '#fff', marginTop: 2, flexDirection: 'row', justifyContent: 'space-between', shadowColor: '#000' },
  scaleTick: { width: 2, height: 9, backgroundColor: '#fff', marginTop: -6 },
  statusBox: { position: 'absolute', left: 6, bottom: 134, backgroundColor: 'rgba(0,0,0,0.45)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  statusText: { color: '#ddd', fontSize: 10, fontVariant: ['tabular-nums'] },
});

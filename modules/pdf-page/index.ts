import { requireNativeModule } from 'expo-modules-core';

export interface RenderedPage {
  /** file:// URI of the rendered image */
  uri: string;
  width: number;
  height: number;
  /** page size in PDF points (top-left origin) — renderRegion's coordinate space */
  pageWidth: number;
  pageHeight: number;
  pageCount: number;
}

export interface RenderedRegion {
  uri: string;
  width: number;
  height: number;
}

const Native = requireNativeModule('PdfPage');

/** Render a whole page, scaled to fit inside maxW x maxH pixels. */
export function renderPage(uri: string, pageIndex: number, maxW: number, maxH: number): Promise<RenderedPage> {
  return Native.renderPage(uri, pageIndex, Math.round(maxW), Math.round(maxH));
}

/** Render the page rectangle [x0,y0]-[x1,y1] (PDF points) at exactly outW x outH pixels. */
export function renderRegion(
  uri: string, pageIndex: number,
  x0: number, y0: number, x1: number, y1: number,
  outW: number, outH: number,
): Promise<RenderedRegion> {
  return Native.renderRegion(uri, pageIndex, x0, y0, x1, y1, Math.round(outW), Math.round(outH));
}

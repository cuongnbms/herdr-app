/** Pan/zoom state: content is drawn at `translate(x, y) scale(scale)` with origin 0 0. */
export type View = { scale: number; x: number; y: number };

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 20;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Zoom by `factor` keeping the content point under (px, py) fixed on screen. */
export function zoomAt(view: View, factor: number, px: number, py: number): View {
  const scale = clamp(view.scale * factor, MIN_SCALE, MAX_SCALE);
  const k = scale / view.scale;
  return { scale, x: px - (px - view.x) * k, y: py - (py - view.y) * k };
}

/** Center content of size w×h in a viewport of size vw×vh, shrinking it to fit with a margin but never enlarging past 1:1. */
export function fitView(w: number, h: number, vw: number, vh: number, margin = 32): View {
  if (w <= 0 || h <= 0 || vw <= 0 || vh <= 0) return { scale: 1, x: 0, y: 0 };
  const scale = clamp(Math.min((vw - 2 * margin) / w, (vh - 2 * margin) / h, 1), MIN_SCALE, MAX_SCALE);
  return { scale, x: (vw - w * scale) / 2, y: (vh - h * scale) / 2 };
}

/** Wheel delta to a zoom factor; works for both notched mice and trackpad pinch. */
export const wheelFactor = (deltaY: number) => Math.exp(-deltaY * 0.002);

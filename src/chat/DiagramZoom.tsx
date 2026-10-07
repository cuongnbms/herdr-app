import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CloseIcon, FitIcon, MinusIcon, PlusIcon } from "../ui/icons";
import { fitView, wheelFactor, zoomAt, type View } from "./zoom";

const STEP = 1.25;

/** Natural size of a rendered diagram: its viewBox, else its on-screen box. */
function svgSize(svg: SVGSVGElement): { w: number; h: number } {
  const vb = (svg.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) return { w: vb[2], h: vb[3] };
  const r = svg.getBoundingClientRect();
  return { w: r.width, h: r.height };
}

/** Full-window viewer for a Mermaid diagram: wheel or pinch to zoom at the cursor, drag to pan. */
export function DiagramZoom({ svg, onClose }: { svg: SVGSVGElement; onClose: () => void }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const size = useRef({ w: 0, h: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });

  const fit = useCallback(() => {
    const r = stageRef.current!.getBoundingClientRect();
    setView(fitView(size.current.w, size.current.h, r.width, r.height));
  }, []);

  const zoomCenter = useCallback((factor: number) => {
    const r = stageRef.current!.getBoundingClientRect();
    setView((v) => zoomAt(v, factor, r.width / 2, r.height / 2));
  }, []);

  // Draw a copy so the diagram in the document stays put; drop Mermaid's max-width so it can grow.
  useLayoutEffect(() => {
    const copy = svg.cloneNode(true) as SVGSVGElement;
    size.current = svgSize(svg);
    copy.removeAttribute("style");
    copy.setAttribute("width", String(size.current.w));
    copy.setAttribute("height", String(size.current.h));
    contentRef.current!.replaceChildren(copy);
    fit();
  }, [svg, fit]);

  // Non-passive so the wheel zooms the diagram instead of scrolling anything behind it.
  useEffect(() => {
    const stage = stageRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      // A trackpad pinch arrives as ctrl+wheel with small deltas; scale it up to feel like a mouse wheel.
      const factor = wheelFactor(e.ctrlKey ? e.deltaY * 5 : e.deltaY);
      setView((v) => zoomAt(v, factor, e.clientX - r.left, e.clientY - r.top));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Leave keys alone while typing in a dialog opened on top (quick open, settings).
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]")) return;
      if (e.key === "Escape") onClose();
      else if (e.key === "+" || e.key === "=") zoomCenter(STEP);
      else if (e.key === "-") zoomCenter(1 / STEP);
      else if (e.key === "0") fit();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, zoomCenter, fit]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    drag.current = { x: e.clientX, y: e.clientY };
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  };
  const endDrag = () => {
    drag.current = null;
  };

  return createPortal(
    // `overlay`: the Files overlay leaves Esc and its ⌘ keys alone while one is open.
    <div className="overlay diagram-zoom" role="dialog" aria-modal="true" aria-label="Diagram">
      <div
        className="diagram-zoom-stage"
        ref={stageRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={fit}
      >
        <div
          className="diagram-zoom-content"
          ref={contentRef}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        />
      </div>
      <div className="diagram-zoom-toolbar">
        <button type="button" className="icon-btn" title="Zoom out (−)" aria-label="Zoom out" onClick={() => zoomCenter(1 / STEP)}>
          <MinusIcon />
        </button>
        <span className="diagram-zoom-level">{Math.round(view.scale * 100)}%</span>
        <button type="button" className="icon-btn" title="Zoom in (+)" aria-label="Zoom in" onClick={() => zoomCenter(STEP)}>
          <PlusIcon />
        </button>
        <button type="button" className="icon-btn" title="Fit (0)" aria-label="Fit" onClick={fit}>
          <FitIcon />
        </button>
        <button type="button" className="icon-btn" title="Close (Esc)" aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
    </div>,
    document.body,
  );
}

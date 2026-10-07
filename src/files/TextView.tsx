import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { findMatches, type Match } from "./find";
import { highlightLines, type Seg } from "./highlightLines";

const DEFAULT_LINE_H = 20;

function lineHeight(el: HTMLElement | null): number {
  if (!el) return DEFAULT_LINE_H;
  const raw = getComputedStyle(el).getPropertyValue("--files-line-h");
  const px = parseFloat(raw);
  return Number.isFinite(px) && px > 0 ? px : DEFAULT_LINE_H;
}

/** Renders one line's segments, wrapping each match range in a <mark>. */
function renderLine(segs: Seg[], matches: Match[], currentStart: number | null): ReactNode[] {
  const out: ReactNode[] = [];
  let pos = 0;
  let m = 0;
  segs.forEach((seg, si) => {
    const segEnd = pos + seg.text.length;
    let at = pos;
    while (at < segEnd) {
      while (m < matches.length && matches[m].end <= at) m++;
      const match = matches[m];
      if (!match || match.start >= segEnd) {
        out.push(<span key={`${si}:${at}`} className={seg.cls || undefined}>{seg.text.slice(at - pos)}</span>);
        at = segEnd;
      } else if (match.start > at) {
        out.push(<span key={`${si}:${at}`} className={seg.cls || undefined}>{seg.text.slice(at - pos, match.start - pos)}</span>);
        at = match.start;
      } else {
        const end = Math.min(match.end, segEnd);
        const current = currentStart === match.start;
        out.push(
          <mark key={`${si}:${at}`} className={current ? "files-match current" : "files-match"}>
            <span className={seg.cls || undefined}>{seg.text.slice(at - pos, end - pos)}</span>
          </mark>,
        );
        at = end;
      }
    }
    pos = segEnd;
  });
  return out;
}

export function TextView({
  text,
  path,
  initialScroll,
  onScroll,
  find,
}: {
  text: string;
  path: string;
  initialScroll: number;
  onScroll(top: number): void;
  find: { query: string; index: number } | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => highlightLines(text, path), [text, path]);
  const plain = useMemo(() => lines.map((l) => l.map((s) => s.text).join("")), [lines]);
  const matches = useMemo(() => (find ? findMatches(plain, find.query) : []), [plain, find]);
  const byLine = useMemo(() => {
    const map = new Map<number, Match[]>();
    for (const m of matches) {
      const list = map.get(m.line);
      if (list) list.push(m);
      else map.set(m.line, [m]);
    }
    return map;
  }, [matches]);
  const current = find && matches.length > 0 ? matches[((find.index % matches.length) + matches.length) % matches.length] : null;

  const rowH = useMemo(() => lineHeight(scrollRef.current), []);
  const virt = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 20,
  });

  // Restore the remembered scroll position when this file is shown.
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = initialScroll;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    if (current) virt.scrollToIndex(current.line, { align: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.line, current?.start]);

  const gutter = `${String(lines.length).length + 1}ch`;

  return (
    <div ref={scrollRef} className="files-text" onScroll={(e) => onScroll(e.currentTarget.scrollTop)}>
      <div className="files-text-body" style={{ height: virt.getTotalSize(), position: "relative" }}>
        {virt.getVirtualItems().map((row) => (
          <div
            key={row.index}
            className="files-line"
            style={{ position: "absolute", top: 0, left: 0, height: rowH, transform: `translateY(${row.start}px)` }}
          >
            <span className="files-gutter" style={{ minWidth: gutter }}>{row.index + 1}</span>
            <span className="files-code">
              {renderLine(lines[row.index], byLine.get(row.index) ?? [], current && current.line === row.index ? current.start : null)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

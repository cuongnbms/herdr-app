import { findMatches } from "./find";

/** Past this many matches the search stops; highlighting more would stall the view. */
export const MAX_DOM_MATCHES = 10_000;

/**
 * DOM ranges for every match of `query` in the text under `root`, in document order. Text is
 * joined across nodes first, so a match may span elements (highlighted code has one span per
 * token). Text inside SVG (mermaid diagrams) is skipped.
 */
export function findRanges(root: Element, query: string, matchCase: boolean): Range[] {
  if (!query) return [];
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest("svg") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    nodes.push(n);
    starts.push(text.length);
    text += n.data;
  }

  // Index of the node holding character `pos` (the last node starting at or before it).
  const nodeAt = (pos: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  // One "line" holding all the text: the same case folding as the source view.
  return findMatches([text], query, matchCase)
    .slice(0, MAX_DOM_MATCHES)
    .map(({ start, end }) => {
      const a = nodeAt(start);
      const b = nodeAt(end - 1);
      const range = document.createRange();
      range.setStart(nodes[a], start - starts[a]);
      range.setEnd(nodes[b], end - starts[b]);
      return range;
    });
}

/** The first match whose top is at or below the top of `root`'s visible area, else 0. */
export function firstVisible(ranges: Range[], root: Element): number {
  const top = root.getBoundingClientRect().top;
  // Matches are in document order, so their tops only grow: binary search keeps this to a
  // handful of layout queries even with thousands of matches.
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid].getBoundingClientRect().top >= top) hi = mid;
    else lo = mid + 1;
  }
  return lo < ranges.length ? lo : 0;
}

/** Scrolls every scroller from the match up to `root` so the match sits mid-view, if it is out of view. */
export function reveal(range: Range, root: Element): void {
  for (let el = range.startContainer.parentElement; el; el = el.parentElement) {
    const r = range.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    if (el.scrollHeight > el.clientHeight && (r.top < box.top || r.bottom > box.bottom)) {
      el.scrollTop += r.top - box.top - (box.height - r.height) / 2;
    }
    if (el.scrollWidth > el.clientWidth && (r.left < box.left || r.right > box.right)) {
      el.scrollLeft += r.left - box.left - (box.width - r.width) / 2;
    }
    if (el === root) break;
  }
}

/** Whether the CSS Custom Highlight API is there (not in jsdom). */
export const hasHighlights = () => typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";

/** Replaces the ranges of the named highlight. */
export function setHighlight(name: string, ranges: Range[]): void {
  if (!hasHighlights()) return;
  let hl = CSS.highlights.get(name);
  if (!hl) {
    hl = new Highlight();
    CSS.highlights.set(name, hl);
  }
  hl.clear();
  for (const r of ranges) hl.add(r);
}

export function clearHighlights(...names: string[]): void {
  if (!hasHighlights()) return;
  for (const name of names) {
    CSS.highlights.get(name)?.clear();
    CSS.highlights.delete(name);
  }
}

/**
 * WebKit does not fully repaint text whose highlight changed, leaving stale marks behind.
 * Nudging the element's opacity for one frame forces a repaint of the whole block.
 */
export function repaint(el: HTMLElement | null): void {
  if (!el || typeof requestAnimationFrame === "undefined") return;
  el.style.opacity = "0.999";
  requestAnimationFrame(() => {
    el.style.opacity = "";
  });
}

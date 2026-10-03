import { useEffect, useRef } from "react";
import type { DragEvent } from "react";
import { useApp } from "../store/app";
import { dropZone, useDragState } from "./dnd";
import type { Drag, DragState, Zone } from "./dnd";
import { canMove, moveBookmark, moveNode, resolve, setBookmarked, useLayout } from "./groups";
import type { NodeRef, SessionKey, Target } from "./groups";

export const NODE_TYPE = "application/x-herdr-node";
const OPEN_DELAY_MS = 600;

type Props = Record<string, unknown>;

const rectZone = (e: DragEvent, row: "session" | "group"): Zone =>
  dropZone(e.currentTarget.getBoundingClientRect(), e.clientY, row);

/** True when the pointer is outside the row; does not rely on `relatedTarget`, which WebKit may leave null. */
const leftRow = (e: DragEvent) => {
  const r = e.currentTarget.getBoundingClientRect();
  return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
};

/** A drop ends the drag even when the source row was remounted and never gets its `dragend`. */
const endDrag = (s: DragState) => {
  s.setDragging(null);
  s.setIndicator(() => null);
};

/** Marks `id` as the only row with an indicator (no state change when it already is). */
const show = (s: DragState, id: string, zone: Zone) =>
  s.setIndicator((p) => (p && p.id === id && p.zone === zone ? p : { id, zone }));
const hide = (s: DragState, id: string) => s.setIndicator((p) => (p && p.id === id ? null : p));

function dragSource(s: DragState, drag: Drag): Props {
  return {
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.setData(NODE_TYPE, JSON.stringify(drag));
      e.dataTransfer.effectAllowed = "move";
      s.setDragging(drag);
    },
    // Every draggable row clears the shared state, whichever row started the drag.
    onDragEnd: () => {
      s.setDragging(null);
      s.setIndicator(() => null);
    },
  };
}

export const indicatorClass = (s: DragState | null, id: string) =>
  s?.indicator?.id === id ? ` drop-${s.indicator.zone}` : "";

const unplacedNow = (): SessionKey[] => {
  const { machines, order } = useApp.getState();
  return resolve(useLayout.getState().layout, machines, order).unplaced;
};

const moveTo = (node: NodeRef, target: Target) => {
  const unplaced = unplacedNow();
  useLayout.getState().update((l) => (canMove(l, node, target) ? moveNode(l, node, target, unplaced) : l));
};

/** Drag source plus drop target for a Session or Group row in the tree. */
export function useTreeRowDnd(ref: NodeRef, id: string, group?: { open: boolean; hasChildren: boolean }): Props {
  const s = useDragState();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const dragging = s?.dragging ?? null;
  useEffect(() => {
    if (!dragging) clearTimer();
  }, [dragging]);
  useEffect(() => clearTimer, []);
  if (!s) return {};

  const targetFor = (zone: Zone): Target => {
    if (ref.kind === "group" && zone === "into") return { kind: "into", groupId: ref.id };
    if (ref.kind === "group" && zone === "after" && group?.open && group.hasChildren) {
      return { kind: "into", groupId: ref.id, first: true };
    }
    return { kind: zone as "before" | "after", ref };
  };
  const nodeDrag = () => (s.dragging?.kind === "node" ? s.dragging : null);

  const onDragOver = (e: DragEvent) => {
    const d = nodeDrag();
    if (!d) return;
    const target = targetFor(rectZone(e, ref.kind));
    const ok = canMove(useLayout.getState().layout, d.ref, target);
    if (ok) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      show(s, id, target.kind);
    } else {
      e.dataTransfer.dropEffect = "none";
      hide(s, id);
    }
    if (ok && ref.kind === "group" && group && !group.open && timer.current === null) {
      const key = `group:${ref.id}`;
      timer.current = setTimeout(() => {
        timer.current = null;
        const app = useApp.getState();
        if (!(app.expanded[key] ?? true)) app.toggle(key, false);
      }, OPEN_DELAY_MS);
    }
  };
  return {
    ...dragSource(s, { kind: "node", ref }),
    onDragEnter: onDragOver,
    onDragOver,
    onDragLeave: (e: DragEvent) => {
      if (!leftRow(e)) return;
      hide(s, id);
      clearTimer();
    },
    onDrop: (e: DragEvent) => {
      const d = nodeDrag();
      endDrag(s);
      clearTimer();
      if (!d) return;
      e.preventDefault();
      moveTo(d.ref, targetFor(rectZone(e, ref.kind)));
    },
  };
}

/** Drop target after the tree: moves a node to the end of the root. */
export function useTreeEndDnd(): Props {
  const s = useDragState();
  if (!s) return {};
  const target: Target = { kind: "into", groupId: null };
  const nodeDrag = () => (s.dragging?.kind === "node" ? s.dragging : null);
  const onDragOver = (e: DragEvent) => {
    const d = nodeDrag();
    if (!d) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    show(s, "tree-end", "into");
  };
  return {
    onDragEnter: onDragOver,
    onDragOver,
    onDragLeave: (e: DragEvent) => leftRow(e) && hide(s, "tree-end"),
    onDrop: (e: DragEvent) => {
      const d = nodeDrag();
      endDrag(s);
      if (!d) return;
      e.preventDefault();
      moveTo(d.ref, target);
    },
  };
}

/** Drag source plus drop target for a Bookmark row; it only accepts Bookmark drags. */
export function useBookmarkRowDnd(key: SessionKey, nextKey: SessionKey | null): Props {
  const s = useDragState();
  if (!s) return {};
  const id = `bookmark:${key}`;
  const bookmarkDrag = () => (s.dragging?.kind === "bookmark" ? s.dragging : null);
  const onDragOver = (e: DragEvent) => {
    if (!bookmarkDrag()) {
      // Bookmark rows take only Bookmark drags; keep a Session drag from reaching the section.
      e.stopPropagation();
      if (s.dragging) e.dataTransfer.dropEffect = "none";
      hide(s, id);
      hide(s, "bookmarks");
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    show(s, id, rectZone(e, "session"));
  };
  return {
    ...dragSource(s, { kind: "bookmark", key }),
    onDragEnter: onDragOver,
    onDragOver,
    onDragLeave: (e: DragEvent) => leftRow(e) && hide(s, id),
    onDrop: (e: DragEvent) => {
      const d = bookmarkDrag();
      endDrag(s);
      e.stopPropagation();
      if (!d) return;
      e.preventDefault();
      const before = rectZone(e, "session") === "before" ? key : nextKey;
      useLayout.getState().update((l) => moveBookmark(l, d.key, before));
    },
  };
}

/** Drop target for the Bookmarks section: a dragged Session becomes a Bookmark. */
export function useBookmarksDropDnd(): Props {
  const s = useDragState();
  if (!s) return {};
  const sessionDrag = () => (s.dragging?.kind === "node" && s.dragging.ref.kind === "session" ? s.dragging.ref : null);
  const onDragOver = (e: DragEvent) => {
    if (!sessionDrag()) {
      if (s.dragging?.kind === "node") e.dataTransfer.dropEffect = "none";
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    show(s, "bookmarks", "into");
  };
  return {
    onDragEnter: onDragOver,
    onDragOver,
    onDragLeave: (e: DragEvent) => leftRow(e) && hide(s, "bookmarks"),
    onDrop: (e: DragEvent) => {
      const ref = sessionDrag();
      endDrag(s);
      if (!ref) return;
      e.preventDefault();
      useLayout.getState().update((l) => setBookmarked(l, ref.key, true));
    },
  };
}

import { useState } from "react";
import type { DragEvent } from "react";
import { dropZone } from "../sidebar/dnd";

export const TAB_TYPE = "application/x-herdr-tab";

type Side = "before" | "after";
type Props = Record<string, unknown>;

/**
 * The `insert_index` for herdr's `tab.move`, which counts gaps in the order before the move;
 * null when the drop would leave the tab where it is.
 */
export function insertIndex(tabIds: string[], from: string, target: string, side: Side): number | null {
  const f = tabIds.indexOf(from);
  const t = tabIds.indexOf(target);
  if (f < 0 || t < 0) return null;
  const i = t + (side === "after" ? 1 : 0);
  return i === f || i === f + 1 ? null : i;
}

const sideOf = (e: DragEvent) => dropZone(e.currentTarget.getBoundingClientRect(), e.clientY, "session") as Side;

/** True when the pointer is outside the row; does not rely on `relatedTarget`, which WebKit may leave null. */
const leftRow = (e: DragEvent) => {
  const r = e.currentTarget.getBoundingClientRect();
  return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
};

/**
 * Drag-to-reorder for the Tabs of one Workspace. A drag only starts and lands inside this
 * Workspace: other Workspaces keep their own state and refuse it.
 */
export function useTabReorder(tabIds: string[], move: (tabId: string, insertIndex: number) => void) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [indicator, setIndicator] = useState<{ tabId: string; side: Side } | null>(null);
  const end = () => {
    setDragging(null);
    setIndicator(null);
  };
  const hide = (tabId: string) => setIndicator((p) => (p?.tabId === tabId ? null : p));

  /** Props for a pane card: dragging it drags its whole Tab. */
  const source = (tabId: string): Props => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.setData(TAB_TYPE, tabId);
      e.dataTransfer.effectAllowed = "move";
      setDragging(tabId);
    },
    onDragEnd: end,
  });

  /** Props for the row that holds a whole Tab. */
  const target = (tabId: string): Props => {
    const onDragOver = (e: DragEvent) => {
      if (!dragging) return;
      const side = sideOf(e);
      if (insertIndex(tabIds, dragging, tabId, side) === null) {
        e.dataTransfer.dropEffect = "none";
        hide(tabId);
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setIndicator((p) => (p?.tabId === tabId && p.side === side ? p : { tabId, side }));
    };
    return {
      onDragEnter: onDragOver,
      onDragOver,
      onDragLeave: (e: DragEvent) => {
        if (leftRow(e)) hide(tabId);
      },
      onDrop: (e: DragEvent) => {
        const from = dragging;
        end();
        if (!from) return;
        const i = insertIndex(tabIds, from, tabId, sideOf(e));
        if (i === null) return;
        e.preventDefault();
        move(from, i);
      },
    };
  };

  const indicatorClass = (tabId: string) => (indicator?.tabId === tabId ? ` drop-${indicator.side}` : "");

  return { source, target, indicatorClass };
}

import { createContext, useContext } from "react";
import type { NodeRef, SessionKey } from "./groups";

export type Zone = "before" | "after" | "into";

/** Which part of a row the pointer is over: halves for a Session, quarters (with `into` in the middle) for a Group. */
export function dropZone(
  rect: { top: number; height: number },
  clientY: number,
  row: "session" | "group",
): Zone {
  if (rect.height <= 0) return row === "session" ? "after" : "into";
  const offset = clientY - rect.top;
  if (row === "session") return offset < rect.height / 2 ? "before" : "after";
  if (offset < rect.height / 4) return "before";
  if (offset >= (3 * rect.height) / 4) return "after";
  return "into";
}

/** What is being dragged: a tree node (Session or Group) or a Bookmark row. */
export type Drag = { kind: "node"; ref: NodeRef } | { kind: "bookmark"; key: SessionKey };
/** The one row that currently shows a drop indicator. */
export type Indicator = { id: string; zone: Zone };
export interface DragState {
  dragging: Drag | null;
  setDragging: (d: Drag | null) => void;
  indicator: Indicator | null;
  setIndicator: (fn: (prev: Indicator | null) => Indicator | null) => void;
}
export const DragContext = createContext<DragState | null>(null);
export const useDragState = () => useContext(DragContext);

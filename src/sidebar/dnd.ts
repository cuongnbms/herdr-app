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

/**
 * With Tauri's native drag-drop off, WebKit loads a file dropped anywhere the page did not
 * handle it. Accept only file drags at the document so they are swallowed; other drags keep
 * their per-target accept/refuse behaviour.
 */
export function guardFileDrops(doc: Document = document): () => void {
  const swallow = (e: DragEvent) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
  };
  doc.addEventListener("dragover", swallow);
  doc.addEventListener("drop", swallow);
  return () => {
    doc.removeEventListener("dragover", swallow);
    doc.removeEventListener("drop", swallow);
  };
}

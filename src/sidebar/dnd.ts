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

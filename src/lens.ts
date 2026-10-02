import type { PaneView } from "./lib/types";

export type LensName = "terminal" | "chat";

export function defaultLens(pane: PaneView, remembered: LensName | undefined): LensName {
  if (remembered) return remembered;
  return pane.agent === "claude" || pane.agent === "pi" ? "chat" : "terminal";
}

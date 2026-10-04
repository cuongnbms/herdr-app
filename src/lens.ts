import type { PaneView } from "./lib/types";

export type LensName = "terminal" | "chat";

export function defaultLens(pane: PaneView, remembered: LensName | undefined): LensName {
  // No agent, nothing to chat with: the Chat lens is off whatever was remembered.
  if (!pane.agent) return "terminal";
  if (remembered) return remembered;
  return pane.agent === "claude" || pane.agent === "pi" ? "chat" : "terminal";
}

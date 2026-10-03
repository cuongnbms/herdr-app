import type { AttachEvent, MachineState } from "../lib/types";
import type { BannerKind } from "./Banner";

export interface LensState {
  banner: { kind: BannerKind; code?: number | null } | null;
  /** The attach was lost and must be reopened once the Machine is observed reconnecting. */
  pending: boolean;
  /** While pending, the Machine has been seen not `connected`. */
  sawDown: boolean;
  /** Bumped to re-run the attach effect. */
  generation: number;
}

export type LensAction =
  | { type: "event"; event: AttachEvent; machine: MachineState | undefined }
  | { type: "open_failed"; machine: MachineState | undefined }
  | { type: "machine"; machine: MachineState | undefined }
  /** The user asked to reattach now (the Disconnected banner's button). */
  | { type: "reattach" };

export const initialLensState: LensState = { banner: null, pending: false, sawDown: false, generation: 0 };

const lost = (s: LensState, machine: MachineState | undefined): LensState => ({
  ...s,
  banner: { kind: "detached" },
  pending: true,
  sawDown: machine !== "connected",
});

export function lensReducer(s: LensState, a: LensAction): LensState {
  switch (a.type) {
    case "event":
      switch (a.event.type) {
        case "attached":
          return { ...s, banner: null };
        case "held":
          return { ...s, banner: { kind: "held" } };
        case "exited":
          return a.machine === "connected"
            ? { ...s, banner: { kind: "exited", code: a.event.code } }
            : lost(s, a.machine);
        case "detached":
          return lost(s, a.machine);
      }
      return s;
    case "open_failed":
      return lost(s, a.machine);
    case "machine":
      if (!s.pending) return s;
      if (a.machine !== "connected") return s.sawDown ? s : { ...s, sawDown: true };
      if (!s.sawDown) return s;
      return { banner: null, pending: false, sawDown: false, generation: s.generation + 1 };
    case "reattach":
      return { banner: null, pending: false, sawDown: false, generation: s.generation + 1 };
  }
}

/** Whether `ev` ends the open it arrived on: the backend sends it nothing more. */
export function endsOpen(ev: AttachEvent): boolean {
  return ev.type !== "attached";
}

/**
 * Whether `ev` frees the cached xterm at once. A visible pane keeps an exited or held xterm
 * for its banner (Reattach and Take over reuse it, scrollback and all); a detach always frees it.
 */
export function disposesOnEvent(ev: AttachEvent, visible: boolean): boolean {
  return ev.type === "detached" || (endsOpen(ev) && !visible);
}

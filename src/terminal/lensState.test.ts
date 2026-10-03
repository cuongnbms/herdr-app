import { describe, expect, it } from "vitest";
import { disposesOnEvent, endsOpen, initialLensState as init, lensReducer as r } from "./lensState";

describe("lensReducer", () => {
  it("re-attaches only after observing a non-connected -> connected transition", () => {
    let s = r(init, { type: "event", event: { type: "detached" }, machine: "connected" });
    expect(s.pending).toBe(true);
    s = r(s, { type: "machine", machine: "connected" });
    expect(s.generation).toBe(0);
    s = r(s, { type: "machine", machine: "error" });
    s = r(s, { type: "machine", machine: "connected" });
    expect(s).toMatchObject({ generation: 1, pending: false, banner: null });
  });
  it("re-attaches immediately on reconnect if the machine was already down", () => {
    let s = r(init, { type: "event", event: { type: "detached" }, machine: "disconnected" });
    s = r(s, { type: "machine", machine: "connected" });
    expect(s.generation).toBe(1);
  });
  it("treats exited on a non-connected machine as a disconnect", () => {
    const s = r(init, { type: "event", event: { type: "exited", code: 1 }, machine: "error" });
    expect(s).toMatchObject({ banner: { kind: "detached" }, pending: true, sawDown: true });
    expect(r(init, { type: "event", event: { type: "exited", code: 1 }, machine: "connected" }).banner).toEqual({
      kind: "exited",
      code: 1,
    });
  });
  it("open failure arms a retry", () => {
    const s = r(init, { type: "open_failed", machine: "connected" });
    expect(s).toMatchObject({ pending: true, sawDown: false });
  });
  it("a manual reattach re-runs the attach at once", () => {
    const s = r(r(init, { type: "event", event: { type: "detached" }, machine: "connected" }), { type: "reattach" });
    expect(s).toMatchObject({ generation: 1, pending: false, sawDown: false, banner: null });
  });
});

describe("open lifetime", () => {
  it("every event but attached ends the open", () => {
    expect(endsOpen({ type: "attached" })).toBe(false);
    expect(endsOpen({ type: "held" })).toBe(true);
    expect(endsOpen({ type: "exited", code: 1 })).toBe(true);
    expect(endsOpen({ type: "detached" })).toBe(true);
  });
  it("a visible pane keeps an exited or held xterm for its banner", () => {
    expect(disposesOnEvent({ type: "exited", code: 1 }, true)).toBe(false);
    expect(disposesOnEvent({ type: "held" }, true)).toBe(false);
  });
  it("a hidden pane frees its xterm when the open ends", () => {
    expect(disposesOnEvent({ type: "exited", code: 1 }, false)).toBe(true);
    expect(disposesOnEvent({ type: "held" }, false)).toBe(true);
    expect(disposesOnEvent({ type: "attached" }, false)).toBe(false);
  });
  it("a detach always frees the xterm", () => {
    expect(disposesOnEvent({ type: "detached" }, true)).toBe(true);
    expect(disposesOnEvent({ type: "detached" }, false)).toBe(true);
  });
});

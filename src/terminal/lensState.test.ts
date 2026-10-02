import { describe, expect, it } from "vitest";
import { initialLensState as init, lensReducer as r } from "./lensState";

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
});

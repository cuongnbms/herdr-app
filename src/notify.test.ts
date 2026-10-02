import { describe, expect, it } from "vitest";
import { shouldNotify } from "./notify";
const ref = { machine_id: "local", session: "default", pane_id: "w1:p1" };
const ev = (status: any, previous: any) => ({ pane: ref, status, previous, title: "Rewrite" });

describe("shouldNotify", () => {
  it("notifies on blocked/done for other panes", () => {
    expect(shouldNotify(ev("blocked", "working"), null, true)).toBe(true);
    expect(shouldNotify(ev("done", "working"), { ...ref, pane_id: "w2:p1" }, true)).toBe(true);
  });
  it("stays quiet otherwise", () => {
    expect(shouldNotify(ev("working", "idle"), null, true)).toBe(false);
    expect(shouldNotify(ev("blocked", "working"), ref, true)).toBe(false);
    expect(shouldNotify(ev("blocked", "working"), null, false)).toBe(false);
    expect(shouldNotify(ev("done", "done"), null, true)).toBe(false);
  });
});

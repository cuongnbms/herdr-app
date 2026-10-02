import { describe, expect, it } from "vitest";
import { prepend, reduce } from "./chatStore";
const u = (t: string) => ({ kind: "user" as const, text: t });
describe("chat store", () => {
  it("resets, appends, prepends and records errors", () => {
    let s = reduce({ items: [], total: 0, error: null }, { type: "reset", items: [u("b")], total: 2 });
    s = reduce(s, { type: "append", items: [u("c")] });
    expect(s.items.map(i => (i as any).text)).toEqual(["b", "c"]);
    expect(s.total).toBe(3);
    s = prepend(s, [u("a")]);
    expect(s.items.map(i => (i as any).text)).toEqual(["a", "b", "c"]);
    s = reduce(s, { type: "error", error: { code: "io", message: "tail exited" } });
    expect(s.error?.code).toBe("io");
    expect(reduce(s, { type: "reset", items: [], total: 0 }).items).toEqual([]);
  });
});

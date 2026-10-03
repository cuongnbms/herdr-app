import { describe, expect, it } from "vitest";
import { emptyChat, prepend, reduce, TRIM_AT, TRIM_TO } from "./chatStore";
const u = (t: string) => ({ kind: "user" as const, text: t });
describe("chat store", () => {
  it("resets, appends, prepends and records errors", () => {
    let s = reduce(emptyChat, { type: "reset", items: [u("b")], total: 2 });
    s = reduce(s, { type: "append", items: [u("c")] });
    expect(s.items.map(i => (i as any).text)).toEqual(["b", "c"]);
    expect(s.total).toBe(3);
    s = prepend(s, [u("a")], 1);
    expect(s.items.map(i => (i as any).text)).toEqual(["a", "b", "c"]);
    s = reduce(s, { type: "error", error: { code: "io", message: "tail exited" } });
    expect(s.error?.code).toBe("io");
    expect(reduce(s, { type: "reset", items: [], total: 0 }).items).toEqual([]);
  });
  it("keeps the latest meta across resets", () => {
    let s = reduce(emptyChat, { type: "meta", model: "m", effort: "high", context_tokens: 5 });
    expect(s.meta).toEqual({ model: "m", effort: "high", context_tokens: 5 });
    s = reduce(s, { type: "reset", items: [], total: 0 });
    expect(s.meta).toEqual({ model: "m", effort: "high", context_tokens: 5 });
  });
  const many = (n: number, from = 0) => Array.from({ length: n }, (_, i) => u(`m${from + i}`));
  it("trims to the newest items when an append at the bottom passes the cap", () => {
    let s = reduce(emptyChat, { type: "reset", items: many(500, 4500), total: 5000 });
    s = reduce(s, { type: "append", items: many(TRIM_AT - 500 + 1, 5000) }, true);
    expect(s.items.length).toBe(TRIM_TO);
    expect(s.total).toBe(5000 + TRIM_AT - 500 + 1);
    expect((s.items[TRIM_TO - 1] as any).text).toBe(`m${s.total - 1}`);
    // Older pages still line up: the item before the first kept one is total - length - 1.
    const before = s.total - s.items.length;
    s = prepend(s, [u(`m${before - 1}`)], before);
    expect((s.items[0] as any).text).toBe(`m${before - 1}`);
    expect((s.items[1] as any).text).toBe(`m${before}`);
  });
  it("does not trim while the user reads older rows", () => {
    let s = reduce(emptyChat, { type: "reset", items: many(500), total: 500 });
    s = reduce(s, { type: "append", items: many(TRIM_AT, 500) }, false);
    expect(s.items.length).toBe(TRIM_AT + 500);
  });
  it("drops an older page fetched before a trim or a reset moved the window", () => {
    let s = reduce(emptyChat, { type: "reset", items: many(500, 4500), total: 5000 });
    const before = s.total - s.items.length;
    const trimmed = reduce(s, { type: "append", items: many(TRIM_AT, 5000) }, true);
    expect(prepend(trimmed, [u("old")], before)).toBe(trimmed);
    const reset = reduce(s, { type: "reset", items: many(10, 90), total: 100 });
    expect(prepend(reset, [u("old")], before)).toBe(reset);
    s = prepend(s, [u(`m${before - 1}`)], before);
    expect(s.items.length).toBe(501);
    expect((s.items[0] as any).text).toBe(`m${before - 1}`);
  });
});

import { describe, expect, it } from "vitest";
import { shareEqual } from "./share";

describe("shareEqual", () => {
  it("returns prev when next is deeply equal", () => {
    const prev = { a: 1, b: [{ c: "x" }, { c: null }], d: { e: true } };
    const next = { a: 1, b: [{ c: "x" }, { c: null }], d: { e: true } };
    expect(shareEqual(prev, next)).toBe(prev);
  });

  it("keeps unchanged branches and rebuilds the changed path", () => {
    const prev = { list: [{ id: 1, v: "a" }, { id: 2, v: "b" }], other: { k: 1 } };
    const next = { list: [{ id: 1, v: "a" }, { id: 2, v: "B" }], other: { k: 1 } };
    const out = shareEqual(prev, next);
    expect(out).not.toBe(prev);
    expect(out).toEqual(next);
    expect(out.other).toBe(prev.other);
    expect(out.list).not.toBe(prev.list);
    expect(out.list[0]).toBe(prev.list[0]);
    expect(out.list[1]).toEqual({ id: 2, v: "B" });
  });

  it("treats added, removed and reordered entries as changes", () => {
    const a = { id: 1 };
    const b = { id: 2 };
    expect(shareEqual([a, b], [{ id: 1 }])).toEqual([{ id: 1 }]);
    expect(shareEqual([a], [{ id: 1 }, { id: 2 }])[0]).toBe(a);
    const swapped = shareEqual([a, b], [{ id: 2 }, { id: 1 }]);
    expect(swapped).toEqual([{ id: 2 }, { id: 1 }]);
    expect(shareEqual({ x: 1 } as Record<string, number>, { x: 1, y: 2 })).toEqual({ x: 1, y: 2 });
    expect(shareEqual({ x: 1, y: 2 } as Record<string, number>, { x: 1 })).toEqual({ x: 1 });
  });

  it("handles type changes and primitives", () => {
    expect(shareEqual<unknown>(null, { a: 1 })).toEqual({ a: 1 });
    expect(shareEqual<unknown>({ a: 1 }, null)).toBeNull();
    expect(shareEqual<unknown>([1], { 0: 1 })).toEqual({ 0: 1 });
    expect(shareEqual("a", "a")).toBe("a");
    expect(shareEqual(1, 2)).toBe(2);
  });
});

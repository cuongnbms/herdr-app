import { describe, expect, it } from "vitest";
import { findMatches } from "./find";

describe("findMatches", () => {
  it("finds case-insensitive, non-overlapping matches per line", () => {
    expect(findMatches(["aAa", "xa"], "aa")).toEqual([{ line: 0, start: 0, end: 2 }]);
    expect(findMatches(["Foo foo", "bar"], "foo")).toEqual([
      { line: 0, start: 0, end: 3 },
      { line: 0, start: 4, end: 7 },
    ]);
    expect(findMatches(["x"], "")).toEqual([]);
  });
  it("keeps offsets of the line when lowercasing changes its length", () => {
    // "İ".toLowerCase() is two units long.
    expect(findMatches(["İx foo FOO"], "foo")).toEqual([
      { line: 0, start: 3, end: 6 },
      { line: 0, start: 7, end: 10 },
    ]);
    expect(findMatches(["aİb"], "İB")).toEqual([{ line: 0, start: 1, end: 3 }]);
  });
  it("matches astral letters, uppercase or not", () => {
    // Deseret: "𐐀" lowercases to "𐐨", both two units long.
    expect(findMatches(["a𐐀b"], "𐐀")).toEqual([{ line: 0, start: 1, end: 3 }]);
    expect(findMatches(["a𐐨b"], "𐐀")).toEqual([{ line: 0, start: 1, end: 3 }]);
    expect(findMatches(["İ𐐀x"], "𐐨X")).toEqual([{ line: 0, start: 1, end: 4 }]);
  });
});

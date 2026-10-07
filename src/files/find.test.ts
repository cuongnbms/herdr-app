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
});

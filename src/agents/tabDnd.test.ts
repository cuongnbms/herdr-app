import { describe, expect, it } from "vitest";
import { insertIndex } from "./tabDnd";

const tabs = ["a", "b", "c", "d"];

describe("insertIndex", () => {
  it("counts gaps in the order before the move, as herdr's tab.move does", () => {
    expect(insertIndex(tabs, "a", "c", "before")).toBe(2);
    expect(insertIndex(tabs, "a", "d", "after")).toBe(4);
    expect(insertIndex(tabs, "d", "b", "before")).toBe(1);
    expect(insertIndex(tabs, "d", "a", "before")).toBe(0);
  });
  it("is null when the drop leaves the tab where it is", () => {
    expect(insertIndex(tabs, "b", "b", "before")).toBeNull();
    expect(insertIndex(tabs, "b", "b", "after")).toBeNull();
    expect(insertIndex(tabs, "b", "a", "after")).toBeNull();
    expect(insertIndex(tabs, "b", "c", "before")).toBeNull();
  });
  it("is null for a tab outside the list", () => {
    expect(insertIndex(tabs, "x", "a", "before")).toBeNull();
    expect(insertIndex(tabs, "a", "x", "before")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { READING_POSITIONS, restoreTarget, rowForItem, savedPosition, savePosition, topVisible } from "./readingPosition";

const at = (item: number, total = 1000, delta = 0) => ({ atBottom: false, item, delta, total });

describe("restoreTarget", () => {
  it("goes to the bottom with nothing saved, when the user was at the bottom, or past the new end", () => {
    expect(restoreTarget(undefined, 1000, 500, 0)).toEqual({ kind: "bottom" });
    expect(restoreTarget({ ...at(600), atBottom: true }, 1000, 500, 0)).toEqual({ kind: "bottom" });
    expect(restoreTarget(at(1000), 1000, 500, 0)).toEqual({ kind: "bottom" });
  });

  it("goes to the saved row when it is loaded, flagging what arrived meanwhile", () => {
    expect(restoreTarget(at(600, 1000, 12), 1000, 500, 0)).toEqual({ kind: "row", item: 600, delta: 12, unseen: false });
    expect(restoreTarget(at(600, 900, 12), 1000, 500, 0)).toEqual({ kind: "row", item: 600, delta: 12, unseen: true });
  });

  it("pages older items in until the row is loaded, at most RESTORE_PAGES times", () => {
    expect(restoreTarget(at(100), 1000, 500, 0)).toEqual({ kind: "page", before: 500 });
    expect(restoreTarget(at(100), 1000, 300, 9)).toEqual({ kind: "page", before: 300 });
    expect(restoreTarget(at(100), 1000, 300, 10)).toEqual({ kind: "row", item: 300, delta: 0, unseen: false });
  });
});

describe("rowForItem", () => {
  it("finds the row holding the item", () => {
    const rows = [{ at: 5 }, { at: 6 }, { at: 9 }];
    expect(rowForItem(rows, 7)).toBe(1);
    expect(rowForItem(rows, 9)).toBe(2);
    expect(rowForItem(rows, 2)).toBe(0);
  });
});

describe("topVisible", () => {
  it("gives the first row reaching into the viewport and how far it is scrolled past", () => {
    const rows = [{ at: 5 }, { at: 6 }, { at: 9 }];
    const shown = [{ index: 0, start: 0, end: 100 }, { index: 1, start: 100, end: 250 }, { index: 2, start: 250, end: 300 }];
    expect(topVisible(rows, shown, 130)).toEqual({ item: 6, delta: 30 });
    expect(topVisible(rows, [], 0)).toBeNull();
  });
});

describe("savedPosition", () => {
  it("keeps one position per pane and transcript, dropping the oldest past the cap", () => {
    savePosition("k0", "/a", at(1));
    savePosition("k0", "/b", at(2));
    expect(savedPosition("k0", "/a")?.item).toBe(1);
    expect(savedPosition("k0", "/b")?.item).toBe(2);
    for (let i = 1; i <= READING_POSITIONS; i++) savePosition(`k${i}`, "/a", at(i));
    expect(savedPosition("k0", "/a")).toBeUndefined();
    expect(savedPosition(`k${READING_POSITIONS}`, "/a")?.item).toBe(READING_POSITIONS);
  });
});

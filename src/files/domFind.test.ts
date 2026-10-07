import { describe, expect, it } from "vitest";
import { findRanges, firstVisible, MAX_DOM_MATCHES } from "./domFind";

const dom = (html: string) => {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
};

describe("findRanges", () => {
  it("lets a match span several text nodes", () => {
    const root = dom("<span>foo</span><span>.</span><span>bar</span> x");
    const ranges = findRanges(root, "o.b", false);
    expect(ranges.map((r) => r.toString())).toEqual(["o.b"]);
    expect(ranges[0].startContainer.textContent).toBe("foo");
    expect(ranges[0].endContainer.textContent).toBe("bar");
  });

  it("finds every match in document order, honouring Match case", () => {
    const root = dom("<p>one Two</p><p>two <b>tWo</b></p>");
    expect(findRanges(root, "two", false).map((r) => r.toString())).toEqual(["Two", "two", "tWo"]);
    expect(findRanges(root, "two", true).map((r) => r.toString())).toEqual(["two"]);
  });

  it("keeps offsets right after a character that grows when lowercased", () => {
    const root = dom("<p>İ foo</p>");
    expect(findRanges(root, "foo", false).map((r) => r.toString())).toEqual(["foo"]);
  });

  it("skips text inside svg diagrams", () => {
    expect(findRanges(dom("<p>node</p><svg><text>node</text></svg>"), "node", false)).toHaveLength(1);
  });

  it("skips the body of a closed <details>, but not its summary", () => {
    const root = dom("<details><summary>a foo</summary><p>hidden foo</p><details open><summary>foo</summary>foo</details></details><p>foo</p>");
    expect(findRanges(root, "foo", false).map((r) => r.startContainer.textContent)).toEqual(["a foo", "foo"]);
    root.querySelector("details")!.setAttribute("open", "");
    expect(findRanges(root, "foo", false)).toHaveLength(5);
  });

  it("finds nothing for an empty query or root, and stops at the limit", () => {
    expect(findRanges(dom("abc"), "", false)).toEqual([]);
    expect(findRanges(dom(""), "x", false)).toEqual([]);
    expect(findRanges(dom("a".repeat(MAX_DOM_MATCHES + 5)), "a", false)).toHaveLength(MAX_DOM_MATCHES);
  });
});

describe("firstVisible", () => {
  const at = (top: number) => ({ getBoundingClientRect: () => ({ top }) }) as unknown as Range;
  const root = { getBoundingClientRect: () => ({ top: 100 }) } as unknown as Element;

  it("picks the first match at or below the top of the view", () => {
    expect(firstVisible([at(0), at(50), at(100), at(400)], root)).toBe(2);
    expect(firstVisible([at(0), at(150)], root)).toBe(1);
  });

  it("falls back to the first match when all are above the view", () => {
    expect(firstVisible([at(0), at(50)], root)).toBe(0);
    expect(firstVisible([], root)).toBe(0);
  });
});

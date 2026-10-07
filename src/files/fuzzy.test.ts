import { describe, expect, it } from "vitest";
import { fuzzyScore, rankFiles } from "./fuzzy";

const paths = ["src/files/FileTree.tsx", "src/files/fuzzy.ts", "docs/tree.md", "src/lib/ipc.ts"];

describe("fuzzy", () => {
  it("matches subsequences case-insensitively", () => {
    expect(fuzzyScore("ftr", "src/files/FileTree.tsx")).not.toBeNull();
    expect(fuzzyScore("zz", "src/lib/ipc.ts")).toBeNull();
  });
  it("prefers file-name and boundary matches", () => {
    expect(rankFiles("tree", paths, [], 50)).toEqual(["docs/tree.md", "src/files/FileTree.tsx"]);
    expect(rankFiles("ipc", paths, [], 50)[0]).toBe("src/lib/ipc.ts");
  });
  it("empty query shows recent first, then the rest, capped", () => {
    expect(rankFiles("", paths, ["src/lib/ipc.ts", "gone.ts"], 3)).toEqual([
      "src/lib/ipc.ts",
      "src/files/FileTree.tsx",
      "src/files/fuzzy.ts",
    ]);
  });
  it("scores a lower-to-upper case change as a boundary", () => {
    expect(fuzzyScore("t", "fooTab")!).toBeGreaterThan(fuzzyScore("t", "footab")!);
  });
  it("anchors the first character at a later boundary when that scores better", () => {
    expect(fuzzyScore("ab", "a_ab")!).toBeGreaterThan(fuzzyScore("ab", "a_xb")!);
  });
  it("takes the whole-path score when it beats the file-name one", () => {
    // In both names `st` sits mid-word; in `src/tests` it also starts two segments.
    expect(rankFiles("st", ["x/tests", "src/tests"], [], 50)).toEqual(["src/tests", "x/tests"]);
    expect(fuzzyScore("lib/ipc", "src/lib/ipc.ts")).not.toBeNull();
    expect(rankFiles("lib/ipc", paths, [], 50)).toEqual(["src/lib/ipc.ts"]);
  });
  it("breaks ties by length, then alphabetically", () => {
    expect(rankFiles("a", ["b/a.ts", "a/a.ts", "c/a.tsx"], [], 50)).toEqual(["a/a.ts", "b/a.ts", "c/a.tsx"]);
  });
  it("caps a non-empty query's results at the limit", () => {
    expect(rankFiles("s", paths, [], 2)).toHaveLength(2);
  });
  it("lists a repeated recent file once", () => {
    expect(rankFiles("", paths, ["docs/tree.md", "docs/tree.md"], 50)).toEqual([
      "docs/tree.md",
      "src/files/FileTree.tsx",
      "src/files/fuzzy.ts",
      "src/lib/ipc.ts",
    ]);
  });
});

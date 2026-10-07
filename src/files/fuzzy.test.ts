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
});

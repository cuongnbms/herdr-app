import { describe, expect, it } from "vitest";
import { dirsToRelist, parentDir } from "./watchDirs";

const ch = (path: string, isDir = false, removed = false) => ({ path, isDir, removed });

describe("watchDirs", () => {
  it("parentDir", () => {
    expect(parentDir("a/b/c")).toBe("a/b");
    expect(parentDir("a")).toBe("");
    expect(parentDir("")).toBe("");
  });

  it("relists parents, and a new or touched folder itself, once each", () => {
    expect(dirsToRelist([ch("src/a.ts"), ch("src/b.ts"), ch("docs", true), ch("old", true, true), ch("", true)])).toEqual(["src", "", "docs"]);
  });
});

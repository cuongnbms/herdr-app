import { describe, expect, it } from "vitest";
import { lineOfHash, resolveLink } from "./links";

describe("resolveLink", () => {
  it("resolves relative and root-relative files", () => {
    expect(resolveLink("docs/a.md", "./b.md")).toEqual({ kind: "file", rel: "docs/b.md", hash: null });
    expect(resolveLink("docs/a.md", "../src/x.ts#L3")).toEqual({ kind: "file", rel: "src/x.ts", hash: "L3" });
    expect(resolveLink("docs/a.md", "/README.md")).toEqual({ kind: "file", rel: "README.md", hash: null });
    expect(resolveLink("docs/a.md", "b%20c.md")).toEqual({ kind: "file", rel: "docs/b c.md", hash: null });
  });
  it("classifies external, anchors and escapes", () => {
    expect(resolveLink("a.md", "https://x.y")).toEqual({ kind: "external", url: "https://x.y" });
    expect(resolveLink("a.md", "#intro")).toEqual({ kind: "anchor", hash: "intro" });
    expect(resolveLink("a.md", "../../etc/passwd")).toBeNull();
  });
  it("percent-decodes fragments, keeping a malformed one as written", () => {
    expect(resolveLink("a.md", "#vi%E1%BB%87t")).toEqual({ kind: "anchor", hash: "việt" });
    expect(resolveLink("a.md", "#100%")).toEqual({ kind: "anchor", hash: "100%" });
    expect(resolveLink("a.md", "b.md#a%20b")).toEqual({ kind: "file", rel: "b.md", hash: "a b" });
  });
  it("reads the line of an L fragment", () => {
    expect(lineOfHash("L3")).toBe(3);
    expect(lineOfHash("L3-L9")).toBe(3);
    expect(lineOfHash("intro")).toBeNull();
    expect(lineOfHash(null)).toBeNull();
  });
});

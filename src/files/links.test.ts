import { describe, expect, it } from "vitest";
import { resolveLink } from "./links";

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
});

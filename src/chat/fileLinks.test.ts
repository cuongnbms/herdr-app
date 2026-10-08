import { describe, expect, it } from "vitest";
import { looksLikePath, relUnderRoot } from "./fileLinks";

describe("looksLikePath", () => {
  it("takes paths with a folder and a file extension", () => {
    expect(looksLikePath("docs/_draft/RASTER_SMOOTHING_COASTLINE_VI.md")).toBe(true);
    expect(looksLikePath("/home/me/app/src/main.rs")).toBe(true);
    expect(looksLikePath("./src/a.test.tsx")).toBe(true);
    expect(looksLikePath("../x/y.config")).toBe(true);
  });
  it("takes a bare file name only with a common extension", () => {
    expect(looksLikePath("README.md")).toBe(true);
    expect(looksLikePath("package.json")).toBe(true);
    expect(looksLikePath("console.log")).toBe(false);
    expect(looksLikePath("os.path")).toBe(false);
  });
  it("leaves out endpoints, versions, code and prose", () => {
    expect(looksLikePath("/point")).toBe(false);
    expect(looksLikePath("src/files")).toBe(false);
    expect(looksLikePath("1.0.0")).toBe(false);
    expect(looksLikePath("v1/2.0")).toBe(false);
    expect(looksLikePath("foo.bar()")).toBe(false);
    expect(looksLikePath("cat a.md")).toBe(false);
    expect(looksLikePath("https://x.io/a.md")).toBe(false);
    expect(looksLikePath("~/notes.md")).toBe(false);
    expect(looksLikePath("")).toBe(false);
  });
});

describe("relUnderRoot", () => {
  it("resolves a relative path against the cwd", () => {
    expect(relUnderRoot("docs/a.md", "/w/app", "/w/app")).toBe("docs/a.md");
    expect(relUnderRoot("./a.md", "/w/app/sub", "/w/app")).toBe("sub/a.md");
    expect(relUnderRoot("../b/a.md", "/w/app/sub", "/w/app")).toBe("b/a.md");
  });
  it("resolves a relative path against the root without a cwd", () => {
    expect(relUnderRoot("docs/a.md", null, "/w/app")).toBe("docs/a.md");
  });
  it("takes an absolute path below the root", () => {
    expect(relUnderRoot("/w/app/src/x.ts", "/elsewhere", "/w/app")).toBe("src/x.ts");
    expect(relUnderRoot("/w/app/src/x.ts", null, "/w/app/")).toBe("src/x.ts");
    expect(relUnderRoot("/etc/hosts.conf", null, "/")).toBe("etc/hosts.conf");
  });
  it("is null outside the root", () => {
    expect(relUnderRoot("/w/other/x.ts", null, "/w/app")).toBeNull();
    expect(relUnderRoot("/w/apple/x.ts", null, "/w/app")).toBeNull();
    expect(relUnderRoot("../x.ts", "/w/app", "/w/app")).toBeNull();
    expect(relUnderRoot("/w/app", null, "/w/app")).toBeNull();
  });
  it("reads a ~ root as the home folder of an absolute path", () => {
    expect(relUnderRoot("/home/me/app/a.md", null, "~/app")).toBe("a.md");
    expect(relUnderRoot("/Users/me/app/a.md", null, "~/app")).toBe("a.md");
    expect(relUnderRoot("/root/app/a.md", null, "~/app")).toBe("a.md");
    expect(relUnderRoot("/srv/app/a.md", null, "~/app")).toBeNull();
    expect(relUnderRoot("a.md", "/home/me/app", "~/app")).toBe("a.md");
  });
});

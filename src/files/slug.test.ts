import { describe, expect, it } from "vitest";
import { makeSlugger, slugify } from "./slug";

describe("slug", () => {
  it("slugifies like GitHub", () => {
    expect(slugify("My Title")).toBe("my-title");
    expect(slugify("What's new? v1.2_beta - ok")).toBe("whats-new-v12_beta---ok");
  });
  it("de-duplicates repeats", () => {
    const s = makeSlugger();
    expect([s("Intro"), s("Intro"), s("Intro"), s("Other")]).toEqual(["intro", "intro-1", "intro-2", "other"]);
  });
});

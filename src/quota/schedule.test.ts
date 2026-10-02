import { describe, expect, it } from "vitest";
import { isDue } from "./schedule";

const now = 1_789_651_000_000;

describe("isDue", () => {
  it("is due when never fetched", () => {
    expect(isDue("tick", null, null, now)).toBe(true);
    expect(isDue("shown", null, null, now)).toBe(true);
  });
  it("tick waits five minutes", () => {
    expect(isDue("tick", now - 299_000, null, now)).toBe(false);
    expect(isDue("tick", now - 300_000, null, now)).toBe(true);
  });
  it("shown waits one minute", () => {
    expect(isDue("shown", now - 59_000, null, now)).toBe(false);
    expect(isDue("shown", now - 60_000, null, now)).toBe(true);
  });
  it("manual is due at once", () => {
    expect(isDue("manual", now, null, now)).toBe(true);
  });
  it("waits out a rate limit whatever the trigger", () => {
    for (const t of ["tick", "shown", "manual"] as const) expect(isDue(t, null, now + 1, now)).toBe(false);
    expect(isDue("shown", null, now, now)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import type { QuotaWindow } from "../lib/types";
import { elapsedFraction, percent, tone, untilReset, updatedAgo } from "./format";

const now = 1_789_650_000_000;
const until = (s: number) => untilReset(now + s * 1000, now);

describe("format", () => {
  it("percent rounds", () => {
    expect(percent(19)).toBe("19%");
    expect(percent(42.5)).toBe("43%");
    expect(percent(0)).toBe("0%");
  });
  it("until reset", () => {
    expect(until(4 * 86_400 + 7_200)).toBe("4d2h");
    expect(until(6 * 86_400 + 23 * 3_600 + 59 * 60)).toBe("6d23h");
    expect(until(2 * 86_400)).toBe("2d");
    expect(until(86_400 + 5 * 3_600 + 59)).toBe("1d5h");
    expect(until(86_400)).toBe("1d");
    expect(until(3_600 + 36 * 60)).toBe("1h36m");
    expect(until(5 * 3_600)).toBe("5h");
    expect(until(36 * 60 + 30)).toBe("36m");
    expect(until(59)).toBe("<1m");
    expect(until(0)).toBe("reset pending");
    expect(until(-600)).toBe("reset pending");
    expect(untilReset(null, now)).toBeNull();
  });
  it("updated ago", () => {
    expect(updatedAgo(now - 30_000, now)).toBe("updated just now");
    expect(updatedAgo(now - 23 * 60_000, now)).toBe("updated 23m ago");
    expect(updatedAgo(now - 3 * 3_600_000, now)).toBe("updated 3h ago");
    expect(updatedAgo(now - 2 * 86_400_000, now)).toBe("updated 2d ago");
  });
  it("elapsed fraction stays on the bar and needs reset and length", () => {
    expect(elapsedFraction(now + 3_600_000, 18_000, now)).toBeCloseTo(0.8);
    expect(elapsedFraction(now + 18_000_000, 18_000, now)).toBeCloseTo(0);
    expect(elapsedFraction(now + 20_000_000, 18_000, now)).toBe(0);
    expect(elapsedFraction(now - 60_000, 18_000, now)).toBe(1);
    expect(elapsedFraction(null, 18_000, now)).toBeNull();
    expect(elapsedFraction(now + 3_600_000, null, now)).toBeNull();
    expect(elapsedFraction(now + 3_600_000, 0, now)).toBeNull();
  });
  it("tone", () => {
    const w = (used: number, resetIn: number | null, dur: number | null): QuotaWindow => ({
      label: "5h", usedPercent: used, resetsAt: resetIn === null ? null : now + resetIn * 1000, durationSecs: dur,
    });
    expect(tone(w(30, 3_600, 18_000), now)).toBe("ok");
    expect(tone(w(80, 3_600, 18_000), now)).toBe("ok");
    expect(tone(w(81, 3_600, 18_000), now)).toBe("warn");
    expect(tone(w(1, 18_000, 18_000), now)).toBe("warn");
    expect(tone(w(90, 60, 18_000), now)).toBe("warn");
    expect(tone(w(95, null, null), now)).toBe("warn");
    expect(tone(w(50, null, 18_000), now)).toBe("muted");
    expect(tone(w(50, 3_600, null), now)).toBe("muted");
  });
});

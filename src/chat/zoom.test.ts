import { describe, expect, it } from "vitest";
import { fitView, MAX_SCALE, MIN_SCALE, wheelFactor, zoomAt } from "./zoom";

describe("zoomAt", () => {
  it("keeps the point under the cursor fixed", () => {
    const v = { scale: 1, x: 10, y: 20 };
    const next = zoomAt(v, 2, 110, 70);
    expect(next.scale).toBe(2);
    // Content point under the cursor before: ((110-10)/1, (70-20)/1) = (100, 50).
    expect((110 - next.x) / next.scale).toBeCloseTo(100);
    expect((70 - next.y) / next.scale).toBeCloseTo(50);
  });

  it("clamps the scale", () => {
    expect(zoomAt({ scale: 1, x: 0, y: 0 }, 1000, 0, 0).scale).toBe(MAX_SCALE);
    expect(zoomAt({ scale: 1, x: 0, y: 0 }, 0.0001, 0, 0).scale).toBe(MIN_SCALE);
  });

  it("a clamped zoom at the limit leaves the view unchanged", () => {
    const v = { scale: MAX_SCALE, x: 5, y: 7 };
    expect(zoomAt(v, 2, 100, 100)).toEqual(v);
  });
});

describe("fitView", () => {
  it("shrinks large content to fit and centers it", () => {
    const v = fitView(2000, 500, 1064, 800, 32);
    expect(v.scale).toBeCloseTo(0.5);
    expect(v.x).toBeCloseTo(32);
    expect(v.y).toBeCloseTo((800 - 250) / 2);
  });

  it("does not enlarge small content", () => {
    expect(fitView(100, 50, 1000, 800)).toEqual({ scale: 1, x: 450, y: 375 });
  });

  it("falls back to identity for unknown sizes", () => {
    expect(fitView(0, 0, 1000, 800)).toEqual({ scale: 1, x: 0, y: 0 });
    expect(fitView(100, 100, 0, 0)).toEqual({ scale: 1, x: 0, y: 0 });
  });
});

describe("wheelFactor", () => {
  it("scrolling up zooms in, down zooms out, symmetrically", () => {
    expect(wheelFactor(-100)).toBeGreaterThan(1);
    expect(wheelFactor(100)).toBeLessThan(1);
    expect(wheelFactor(-100) * wheelFactor(100)).toBeCloseTo(1);
  });
});

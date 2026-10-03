import { describe, expect, it } from "vitest";
import { LOSS_LIMIT, LOSS_WINDOW_MS, WebglLru, mayUseWebgl, recordLoss } from "./webglPolicy";

describe("WebglLru", () => {
  it("evicts the least recently shown beyond capacity", () => {
    const lru = new WebglLru(3);
    expect(lru.touch("a")).toEqual([]);
    expect(lru.touch("b")).toEqual([]);
    expect(lru.touch("c")).toEqual([]);
    expect(lru.touch("d")).toEqual(["a"]);
    expect(lru.keys()).toEqual(["d", "c", "b"]);
  });
  it("re-showing a key moves it to the front instead of evicting", () => {
    const lru = new WebglLru(2);
    lru.touch("a");
    lru.touch("b");
    expect(lru.touch("a")).toEqual([]);
    expect(lru.touch("c")).toEqual(["b"]);
    expect(lru.keys()).toEqual(["c", "a"]);
  });
  it("removed keys free their slot", () => {
    const lru = new WebglLru(2);
    lru.touch("a");
    lru.touch("b");
    lru.remove("a");
    expect(lru.touch("c")).toEqual([]);
    expect(lru.keys()).toEqual(["c", "b"]);
  });
});

describe("context-loss window", () => {
  it("allows WebGL until LOSS_LIMIT losses fall inside the window", () => {
    let losses: number[] = [];
    for (let i = 0; i < LOSS_LIMIT - 1; i++) losses = recordLoss(losses, 1000 + i);
    expect(mayUseWebgl(losses, 2000)).toBe(true);
    losses = recordLoss(losses, 2000);
    expect(mayUseWebgl(losses, 2000)).toBe(false);
  });
  it("forgets losses older than the window", () => {
    let losses: number[] = [];
    for (let i = 0; i < LOSS_LIMIT; i++) losses = recordLoss(losses, i);
    expect(mayUseWebgl(losses, LOSS_WINDOW_MS + LOSS_LIMIT)).toBe(true);
    expect(recordLoss(losses, LOSS_WINDOW_MS + LOSS_LIMIT)).toEqual([LOSS_WINDOW_MS + LOSS_LIMIT]);
  });
});

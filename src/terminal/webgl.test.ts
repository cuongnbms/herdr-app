import { afterEach, describe, expect, it, vi } from "vitest";
import { activeWebgl, forgetWebgl, lossesOf, showWebgl } from "./webgl";
import { WEBGL_CONTEXTS } from "./webglPolicy";

function fakeAddon() {
  let lost: (() => void) | undefined;
  return {
    dispose: vi.fn(),
    onContextLoss: (l: () => void) => {
      lost = l;
    },
    lose: () => lost?.(),
  };
}

const term = () => ({ element: document.createElement("div"), loadAddon: vi.fn() }) as any;

const keys = Array.from({ length: WEBGL_CONTEXTS + 2 }, (_, i) => `k${i}`);

afterEach(() => {
  keys.forEach(forgetWebgl);
  vi.restoreAllMocks();
});

describe("showWebgl", () => {
  it("keeps at most WEBGL_CONTEXTS renderers and evictions are not counted as losses", () => {
    const addons = keys.map(() => fakeAddon());
    keys.forEach((k, i) => showWebgl(k, term(), () => addons[i]));
    expect(activeWebgl()).toBe(WEBGL_CONTEXTS);
    expect(addons[0].dispose).toHaveBeenCalled();
    expect(addons[1].dispose).toHaveBeenCalled();
    expect(addons[2].dispose).not.toHaveBeenCalled();
    expect(lossesOf("k0")).toEqual([]);
  });
  it("reattaches an evicted terminal when it is shown again", () => {
    const t = term();
    keys.forEach((k) => showWebgl(k, k === "k0" ? t : term(), fakeAddon));
    showWebgl("k0", t, fakeAddon);
    expect(t.loadAddon).toHaveBeenCalledTimes(2);
  });
  it("drops the renderer on context loss and stays on DOM after repeated losses", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = term();
    for (let i = 0; i < 3; i++) {
      const a = fakeAddon();
      showWebgl("k0", t, () => a);
      a.lose();
      expect(a.dispose).toHaveBeenCalled();
      expect(activeWebgl()).toBe(0);
    }
    expect(lossesOf("k0")).toHaveLength(3);
    showWebgl("k0", t, fakeAddon);
    expect(t.loadAddon).toHaveBeenCalledTimes(3);
  });
  it("falls back to DOM when the addon cannot activate", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = fakeAddon();
    const t = term();
    t.loadAddon.mockImplementation(() => {
      throw new Error("WebGL2 not supported");
    });
    showWebgl("k0", t, () => a);
    expect(a.dispose).toHaveBeenCalled();
    expect(activeWebgl()).toBe(0);
  });
  it("forgetting a terminal frees its slot", () => {
    keys.slice(0, WEBGL_CONTEXTS).forEach((k) => showWebgl(k, term(), fakeAddon));
    forgetWebgl("k0");
    const a = fakeAddon();
    showWebgl("k1", term(), () => a);
    showWebgl("k7", term(), fakeAddon);
    expect(activeWebgl()).toBe(WEBGL_CONTEXTS);
    expect(a.dispose).not.toHaveBeenCalled();
  });
});

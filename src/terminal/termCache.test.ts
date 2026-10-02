import { describe, expect, it, vi } from "vitest";
import { claim, dispose, disposeIf, getOrCreate, size } from "./termCache";

describe("termCache", () => {
  it("reuses entries and disposes them", () => {
    const disposeFn = vi.fn();
    const factory = vi.fn(() => ({ term: { dispose: disposeFn } as any, fit: {} as any }));
    const a = getOrCreate("local/default/term_a", factory);
    const b = getOrCreate("local/default/term_a", factory);
    expect(a).toBe(b);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(size()).toBe(1);
    dispose("local/default/term_a");
    expect(disposeFn).toHaveBeenCalled();
    expect(size()).toBe(0);
  });
  it("a stale open's detach does not dispose the entry a newer open took", () => {
    const disposeFn = vi.fn();
    const factory = () => ({ term: { dispose: disposeFn } as any, fit: {} as any });
    getOrCreate("k", factory);
    const first = claim("k");
    const second = claim("k");
    expect(disposeIf("k", first)).toBe(false);
    expect(size()).toBe(1);
    expect(disposeFn).not.toHaveBeenCalled();
    expect(disposeIf("k", second)).toBe(true);
    expect(size()).toBe(0);
  });
});

import { describe, expect, it, vi } from "vitest";
import { dispose, getOrCreate, size } from "./termCache";

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
});

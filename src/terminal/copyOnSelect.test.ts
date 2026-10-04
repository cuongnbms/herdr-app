import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyCopyOnSelect, COPY_SETTLE_MS } from "./copyOnSelect";

// jsdom has no matchMedia; xterm's renderer watches the device pixel ratio through it.
window.matchMedia ??= () => ({ matches: false, addListener() {}, removeListener() {} }) as unknown as MediaQueryList;

afterEach(() => vi.useRealTimers());

async function termWith(text: string) {
  const term = new Terminal({ cols: 40, rows: 5 });
  // Selection lives in the renderer side, which exists only once the terminal is opened.
  term.open(document.createElement("div"));
  await new Promise<void>((r) => term.write(text, r));
  return term;
}

describe("applyCopyOnSelect", () => {
  it("copies the selection once it settles", async () => {
    const term = await termWith("hello world");
    vi.useFakeTimers();
    const write = vi.fn();
    applyCopyOnSelect(term, write);
    term.select(0, 0, 3);
    term.select(0, 0, 5);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(COPY_SETTLE_MS);
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith("hello");
    term.dispose();
  });

  it("does not copy a cleared selection", async () => {
    const term = await termWith("hello");
    vi.useFakeTimers();
    const write = vi.fn();
    applyCopyOnSelect(term, write);
    term.select(0, 0, 5);
    term.clearSelection();
    vi.advanceTimersByTime(COPY_SETTLE_MS);
    expect(write).not.toHaveBeenCalled();
    term.dispose();
  });

  it("stops copying once disposed", async () => {
    const term = await termWith("hello");
    vi.useFakeTimers();
    const write = vi.fn();
    const dispose = applyCopyOnSelect(term, write);
    term.select(0, 0, 5);
    dispose();
    vi.advanceTimersByTime(COPY_SETTLE_MS);
    expect(write).not.toHaveBeenCalled();
    term.dispose();
  });
});

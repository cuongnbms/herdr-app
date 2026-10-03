import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HIDDEN_FLUSH_MS, SLICE_BYTES, createOutputBuffer } from "./outputBuffer";

type Write = (data: Uint8Array, cb: () => void) => void;

function fakeTerm() {
  const writes: { data: Uint8Array; cb: () => void }[] = [];
  const write = vi.fn<Write>((data, cb) => writes.push({ data, cb }));
  /** Simulates xterm finishing the parse of every write so far. */
  const parseAll = () => writes.splice(0).forEach((w) => w.cb());
  return { write, writes, parseAll };
}

const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill);

describe("createOutputBuffer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("writes straight through while visible, without copying", () => {
    const t = fakeTerm();
    const out = createOutputBuffer(t.write);
    out.setVisible(true);
    const chunk = bytes(10);
    const parsed = vi.fn();
    out.write(chunk, parsed);
    expect(t.write).toHaveBeenCalledTimes(1);
    expect(t.writes[0].data).toBe(chunk);
    t.parseAll();
    expect(parsed).toHaveBeenCalledTimes(1);
  });

  it("starts hidden and holds output until the flush interval", () => {
    const t = fakeTerm();
    const out = createOutputBuffer(t.write);
    out.write(bytes(3, 1), () => {});
    out.write(bytes(2, 2), () => {});
    expect(t.write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(HIDDEN_FLUSH_MS);
    expect(t.write).toHaveBeenCalledTimes(1);
    expect([...t.writes[0].data]).toEqual([1, 1, 1, 2, 2]);
  });

  it("writes a lone pending chunk without concatenating", () => {
    const t = fakeTerm();
    const out = createOutputBuffer(t.write);
    const chunk = bytes(4);
    out.write(chunk, () => {});
    vi.advanceTimersByTime(HIDDEN_FLUSH_MS);
    expect(t.writes[0].data).toBe(chunk);
  });

  it("drains at most two whole-chunk slices per interval while hidden", () => {
    const t = fakeTerm();
    const out = createOutputBuffer(t.write);
    const half = SLICE_BYTES / 2;
    for (let i = 0; i < 10; i++) out.write(bytes(half), () => {});
    vi.advanceTimersByTime(HIDDEN_FLUSH_MS);
    expect(t.writes.map((w) => w.data.byteLength)).toEqual([SLICE_BYTES, SLICE_BYTES]);
    vi.advanceTimersByTime(HIDDEN_FLUSH_MS);
    expect(t.writes).toHaveLength(4);
    vi.advanceTimersByTime(HIDDEN_FLUSH_MS);
    expect(t.writes).toHaveLength(5);
    vi.advanceTimersByTime(HIDDEN_FLUSH_MS * 3);
    expect(t.writes).toHaveLength(5);
  });

  it("never splits a chunk larger than a slice", () => {
    const t = fakeTerm();
    const out = createOutputBuffer(t.write);
    out.write(bytes(SLICE_BYTES * 3), () => {});
    vi.advanceTimersByTime(HIDDEN_FLUSH_MS);
    expect(t.writes.map((w) => w.data.byteLength)).toEqual([SLICE_BYTES * 3]);
  });

  it("acks every chunk exactly once, only after its slice is parsed", () => {
    const t = fakeTerm();
    const out = createOutputBuffer(t.write);
    const sizes = [5000, 9000, 20000, 1, 7000, 16384, 300];
    const parsed = sizes.map(() => vi.fn());
    sizes.forEach((n, i) => out.write(bytes(n), parsed[i]));
    vi.advanceTimersByTime(HIDDEN_FLUSH_MS * 10);
    parsed.forEach((p) => expect(p).not.toHaveBeenCalled());
    t.parseAll();
    parsed.forEach((p) => expect(p).toHaveBeenCalledTimes(1));
    expect(t.write.mock.calls.reduce((n, c) => n + c[0].byteLength, 0)).toBe(sizes.reduce((a, b) => a + b));
  });

  it("flushes everything at once when shown, then writes directly", () => {
    const t = fakeTerm();
    const out = createOutputBuffer(t.write);
    const parsed = vi.fn();
    for (let i = 0; i < 6; i++) out.write(bytes(SLICE_BYTES, i), parsed);
    out.setVisible(true);
    expect(t.writes).toHaveLength(1);
    expect(t.writes[0].data.byteLength).toBe(SLICE_BYTES * 6);
    expect(t.writes[0].data[SLICE_BYTES * 5]).toBe(5);
    t.parseAll();
    expect(parsed).toHaveBeenCalledTimes(6);
    out.write(bytes(1), () => {});
    expect(t.writes).toHaveLength(1);
    vi.advanceTimersByTime(HIDDEN_FLUSH_MS * 4);
    expect(t.write).toHaveBeenCalledTimes(2);
  });

  it("keeps order across a hide/show bounce (reattach)", () => {
    const t = fakeTerm();
    const out = createOutputBuffer(t.write);
    out.setVisible(true);
    out.write(bytes(1, 1), () => {});
    out.setVisible(false);
    out.write(bytes(1, 2), () => {});
    out.setVisible(true);
    out.write(bytes(1, 3), () => {});
    expect(t.writes.map((w) => w.data[0])).toEqual([1, 2, 3]);
    vi.advanceTimersByTime(HIDDEN_FLUSH_MS);
    expect(t.writes).toHaveLength(3);
  });

  it("drops pending output on dispose", () => {
    const t = fakeTerm();
    const out = createOutputBuffer(t.write);
    const parsed = vi.fn();
    out.write(bytes(10), parsed);
    out.dispose();
    vi.advanceTimersByTime(HIDDEN_FLUSH_MS * 4);
    out.setVisible(true);
    out.write(bytes(10), parsed);
    expect(t.write).not.toHaveBeenCalled();
    expect(parsed).not.toHaveBeenCalled();
  });
});

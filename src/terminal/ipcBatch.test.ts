import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAckBatcher, createInputQueue } from "./ipcBatch";

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createInputQueue", () => {
  it("sends the first input immediately", () => {
    const send = vi.fn(() => Promise.resolve());
    createInputQueue(send).push("a");
    expect(send).toHaveBeenCalledWith("a");
  });

  it("merges input typed while a write is in flight into one ordered write", async () => {
    const writes = [deferred(), deferred(), deferred()];
    const send = vi.fn((_: string) => writes[send.mock.calls.length - 1].promise);
    const q = createInputQueue(send);
    q.push("a");
    q.push("b");
    q.push("c");
    expect(send.mock.calls.map((c) => c[0])).toEqual(["a"]);
    writes[0].resolve();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1][0]).toBe("bc");
    writes[1].resolve();
    await Promise.resolve();
    q.push("d");
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(send.mock.calls[2][0]).toBe("d");
  });

  it("keeps going after a failed write", async () => {
    const first = deferred();
    const send = vi.fn((_: string) => (send.mock.calls.length === 1 ? first.promise : Promise.resolve()));
    const q = createInputQueue(send);
    q.push("a");
    q.push("b");
    first.reject(new Error("gone"));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1][0]).toBe("b");
  });

  it("drops queued input once disposed", async () => {
    const first = deferred();
    const send = vi.fn((_: string) => first.promise);
    const q = createInputQueue(send);
    q.push("a");
    q.push("b");
    q.dispose();
    first.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("createAckBatcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sums acks within a tick into one call", () => {
    const ack = vi.fn(() => Promise.resolve());
    const b = createAckBatcher(ack);
    b.add(100);
    b.add(200);
    b.add(300);
    expect(ack).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith(600);
  });

  it("flushes at once when the threshold is reached", () => {
    const ack = vi.fn(() => Promise.resolve());
    const b = createAckBatcher(ack, 1000);
    b.add(600);
    b.add(600);
    expect(ack).toHaveBeenCalledWith(1200);
    vi.runAllTimers();
    expect(ack).toHaveBeenCalledTimes(1);
    b.add(5);
    vi.runAllTimers();
    expect(ack).toHaveBeenLastCalledWith(5);
  });

  it("swallows ack failures", async () => {
    const ack = vi.fn(() => Promise.reject(new Error("gone")));
    const b = createAckBatcher(ack);
    b.add(1);
    vi.runAllTimers();
    await Promise.resolve();
    expect(ack).toHaveBeenCalledTimes(1);
  });
});

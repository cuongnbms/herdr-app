import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class<T> { onmessage: (e: T) => void = () => {}; },
  invoke: vi.fn(),
}));
vi.mock("../lib/ipc", () => ({ chatBtwAsk: vi.fn(), chatBtwCancel: vi.fn(), chatBtwDiscard: vi.fn() }));
import { chatBtwAsk, chatBtwCancel, chatBtwDiscard } from "../lib/ipc";
import type { BtwEvent } from "../lib/types";
import { askSide, closeSide, stopSide, useBtw } from "./btw";

const pane = { machine_id: "devtuf", session: "default", pane_id: "w1:p1" };
const key = "devtuf/default/w1:p1";
const thread = () => Object.values(useBtw.getState().threads)[0];

/** Makes the next chatBtwAsk hand its channel to the test and wait for `finish`. */
function nextAsk() {
  let send!: (e: BtwEvent) => void;
  let finish!: (err?: Error) => void;
  vi.mocked(chatBtwAsk).mockImplementationOnce((_m, _p, _q, _f, _a, ch) => {
    send = (e) => (ch as unknown as { onmessage: (e: BtwEvent) => void }).onmessage(e);
    return new Promise<void>((res, rej) => (finish = (err) => (err ? rej(err) : res())));
  });
  return { send: (e: BtwEvent) => send(e), finish: (err?: Error) => finish(err) };
}

beforeEach(() => {
  vi.mocked(chatBtwAsk).mockReset();
  vi.mocked(chatBtwCancel).mockReset().mockResolvedValue(undefined);
  vi.mocked(chatBtwDiscard).mockReset().mockResolvedValue(undefined);
  useBtw.setState({ threads: {}, mode: {} });
});

describe("side questions", () => {
  it("streams an answer and keeps the fork for a follow-up", async () => {
    const a = nextAsk();
    const p = askSide(pane, "/p/t1.jsonl", "why?");
    a.send({ kind: "delta", text: "Be" });
    a.send({ kind: "tool", name: "Read" });
    a.send({ kind: "delta", text: "cause" });
    a.send({ kind: "done", fork_id: "f1", cache_read: 9, input: 1 });
    a.finish();
    await p;
    expect(thread()).toMatchObject({ forkId: "f1", turns: [{ q: "why?", a: "Because", tools: ["Read"], running: false }] });
    expect(vi.mocked(chatBtwAsk).mock.calls[0].slice(0, 4)).toEqual(["devtuf", "/p/t1.jsonl", "why?", null]);

    const b = nextAsk();
    const q = askSide(pane, "/p/t1.jsonl", "and?");
    b.finish();
    await q;
    expect(vi.mocked(chatBtwAsk).mock.calls[1][3]).toBe("f1");
    expect(thread().turns).toHaveLength(2);
  });

  it("refuses a second question while one runs", async () => {
    const a = nextAsk();
    const p = askSide(pane, "/p/t1.jsonl", "one");
    await askSide(pane, "/p/t1.jsonl", "two");
    expect(chatBtwAsk).toHaveBeenCalledTimes(1);
    a.finish();
    await p;
  });

  it("shows a failed ask in its turn", async () => {
    const a = nextAsk();
    const p = askSide(pane, "/p/t1.jsonl", "q");
    a.finish(Object.assign(new Error("x"), { message: "claude not found on this machine" }));
    await p;
    expect(thread().turns[0]).toMatchObject({ running: false, error: "claude not found on this machine" });
  });

  it("closing a running thread cancels before discarding, and a late done is ignored", async () => {
    const a = nextAsk();
    const p = askSide(pane, "/p/t1.jsonl", "q");
    a.send({ kind: "done", fork_id: "f1", cache_read: 0, input: 0 });
    await closeSide(pane);
    expect(chatBtwCancel).toHaveBeenCalledTimes(1);
    expect(chatBtwDiscard).toHaveBeenCalledWith("devtuf", "/p/t1.jsonl", "f1");
    expect(vi.mocked(chatBtwCancel).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(chatBtwDiscard).mock.invocationCallOrder[0]);
    a.send({ kind: "delta", text: "late" });
    a.finish();
    await p;
    expect(useBtw.getState().threads[key]).toBeUndefined();
  });

  it("a question on another transcript discards the old thread", async () => {
    const a = nextAsk();
    const p = askSide(pane, "/p/t1.jsonl", "q");
    a.send({ kind: "done", fork_id: "f1", cache_read: 0, input: 0 });
    a.finish();
    await p;
    const b = nextAsk();
    const q = askSide(pane, "/p/t2.jsonl", "q2");
    b.finish();
    await q;
    expect(chatBtwDiscard).toHaveBeenCalledWith("devtuf", "/p/t1.jsonl", "f1");
    expect(thread()).toMatchObject({ path: "/p/t2.jsonl", turns: [{ q: "q2" }] });
  });

  it("stop cancels the running ask", async () => {
    nextAsk();
    void askSide(pane, "/p/t1.jsonl", "q");
    await stopSide(key);
    expect(chatBtwCancel).toHaveBeenCalledTimes(1);
    expect(thread().turns[0].running).toBe(false);
  });
});

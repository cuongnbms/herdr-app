import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import { chatBtwAsk, chatBtwCancel, chatBtwDiscard } from "../lib/ipc";
import { paneKey, type BtwEvent, type PaneRef } from "../lib/types";

// Side questions ("btw") per Pane: a thread is the chain of questions asked against one fork
// of the Transcript, kept in memory only. The fork file on the Machine is deleted on close.
export interface BtwTurn {
  q: string;
  a: string;
  tools: string[];
  running: boolean;
  error?: string;
}

export interface BtwThread {
  /** The Transcript the fork was made from. */
  path: string;
  /** Set by the first `done`; later questions resume it. */
  forkId?: string;
  /** The ask in flight, if the last turn runs. */
  askId?: string;
  turns: BtwTurn[];
}

export const useBtw = create<{ threads: Record<string, BtwThread>; mode: Record<string, boolean> }>(() => ({
  threads: {},
  mode: {},
}));

export function setBtwMode(key: string, on: boolean): void {
  useBtw.setState((s) => ({ mode: { ...s.mode, [key]: on } }));
}

const messageOf = (err: unknown) => (err as { message?: string } | null)?.message ?? String(err);

/** Applies `fn` to the thread at `key` while it still belongs to `askId`; closed or replaced threads are left alone. */
function patch(key: string, askId: string, fn: (t: BtwThread) => BtwThread): void {
  useBtw.setState((s) => {
    const t = s.threads[key];
    if (!t || t.askId !== askId) return s;
    return { threads: { ...s.threads, [key]: fn(t) } };
  });
}

function patchLast(key: string, askId: string, fn: (turn: BtwTurn) => BtwTurn): void {
  patch(key, askId, (t) => ({ ...t, turns: t.turns.map((turn, i) => (i === t.turns.length - 1 ? fn(turn) : turn)) }));
}

export async function askSide(pane: PaneRef, path: string, question: string): Promise<void> {
  const key = paneKey(pane);
  let thread: BtwThread | undefined = useBtw.getState().threads[key];
  if (thread?.turns[thread.turns.length - 1]?.running) return;
  if (thread && thread.path !== path) {
    void closeSide(pane); // removes the thread at once; the discard finishes in the background
    thread = undefined;
  }
  const askId = crypto.randomUUID();
  const forkId = thread?.forkId ?? null;
  const turn: BtwTurn = { q: question, a: "", tools: [], running: true };
  useBtw.setState((s) => ({
    threads: { ...s.threads, [key]: { path, forkId: thread?.forkId, askId, turns: [...(thread?.turns ?? []), turn] } },
  }));

  const events = new Channel<BtwEvent>();
  events.onmessage = (e) => {
    if (e.kind === "delta") patchLast(key, askId, (t) => ({ ...t, a: t.a + e.text }));
    else if (e.kind === "tool") patchLast(key, askId, (t) => ({ ...t, tools: [...t.tools, e.name] }));
    else if (e.kind === "done") patch(key, askId, (t) => ({ ...t, forkId: e.fork_id }));
    else patchLast(key, askId, (t) => ({ ...t, error: e.message }));
  };
  try {
    await chatBtwAsk(pane.machine_id, path, question, forkId, askId, events);
  } catch (err) {
    patchLast(key, askId, (t) => ({ ...t, error: messageOf(err) }));
  }
  patchLast(key, askId, (t) => ({ ...t, running: false }));
}

export async function stopSide(key: string): Promise<void> {
  const askId = useBtw.getState().threads[key]?.askId;
  if (!askId) return;
  await chatBtwCancel(askId).catch(() => {});
  patchLast(key, askId, (t) => ({ ...t, running: false }));
}

/** Removes the thread, stops its ask, then deletes the fork on the Machine; failures are ignored. */
export async function closeSide(pane: PaneRef): Promise<void> {
  const key = paneKey(pane);
  const thread = useBtw.getState().threads[key];
  if (!thread) return;
  useBtw.setState((s) => {
    const threads = { ...s.threads };
    delete threads[key];
    return { threads };
  });
  const running = thread.turns[thread.turns.length - 1]?.running;
  if (running && thread.askId) await chatBtwCancel(thread.askId).catch(() => {});
  if (thread.forkId) await chatBtwDiscard(pane.machine_id, thread.path, thread.forkId).catch(() => {});
}

import { Channel } from "@tauri-apps/api/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { chatPage } from "../lib/ipc";
import { paneKey, type AppError, type ChatEvent, type ChatItem, type Located, type PaneRef, type PaneView } from "../lib/types";
import { useApp } from "../store/app";
import { onOpenFailure, openChat, watchMachine } from "./chatSession";
import { BlockedPanel } from "./BlockedPanel";
import { emptyChat, prepend, reduce, type ChatState } from "./chatStore";
import { ChatItemView } from "./ChatItemView";
import { Composer } from "./Composer";
import { forgetTranscript, rememberedTranscript, rememberTranscript, TranscriptPicker } from "./TranscriptPicker";

type Action = ChatEvent | { type: "prepend"; items: ChatItem[] };
const reducer = (s: ChatState, a: Action): ChatState => (a.type === "prepend" ? prepend(s, a.items) : reduce(s, a));

type ToolResult = Extract<ChatItem, { kind: "tool_result" }>;

export function ChatLens({ pane, view }: { pane: PaneRef; view: PaneView }) {
  const key = paneKey(pane);
  const setLensOverride = useApp((s) => s.setLensOverride);
  const setLensNote = useApp((s) => s.setLensNote);
  const machineState = useApp((s) => s.machines[pane.machine_id]?.state);
  const sawDown = useRef(false);
  const [state, dispatch] = useReducer(reducer, emptyChat);
  const [located, setLocated] = useState<Located | null>(null);
  const [openError, setOpenError] = useState<AppError | null>(null);
  const [unseen, setUnseen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const loadingOlder = useRef(false);
  const anchor = useRef<number | null>(null);
  const forceBottom = useRef(true);
  const generation = useRef(0);
  const handle = useRef<{ close: () => void } | null>(null);

  const open = useCallback(
    (path: string | null) => {
      const gen = ++generation.current;
      setOpenError(null);
      const channel = new Channel<ChatEvent>();
      channel.onmessage = (ev) => {
        if (gen !== generation.current) return;
        if (ev.type === "reset") forceBottom.current = true;
        dispatch(ev);
      };
      handle.current?.close();
      const h = openChat(pane, path, channel);
      handle.current = h;
      h.opened
        .then((l) => {
          if (gen !== generation.current || !l) return;
          setLocated(l);
          setLensNote(key, null);
        })
        .catch((e: AppError) => {
          if (gen !== generation.current) return;
          const machine = useApp.getState().machines[pane.machine_id]?.state;
          switch (onOpenFailure(path, e, machine)) {
            case "retry_auto":
              forgetTranscript(key);
              open(null);
              break;
            case "fallback":
              // In memory only: a fresh pane's transcript appears after its first prompt.
              setLensNote(key, "No conversation transcript found for this pane; showing the terminal.");
              setLensOverride(key, "terminal");
              break;
            case "error":
              setOpenError(e);
          }
        });
    },
    [pane, key, setLensOverride, setLensNote],
  );

  // The tail dies with an ssh drop: reopen once the Machine is back.
  useEffect(() => {
    const w = watchMachine(sawDown.current, machineState);
    sawDown.current = w.sawDown;
    if (w.reopen) open(rememberedTranscript(key));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineState]);

  useEffect(() => {
    open(rememberedTranscript(key));
    return () => {
      generation.current++;
      handle.current?.close();
      handle.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const choose = (path: string) => {
    rememberTranscript(key, path);
    open(path);
  };

  // Tool results render inside their call; standalone only when no matching call is loaded.
  const { rows, results } = useMemo(() => {
    const calls = new Set<string>();
    const results = new Map<string, ToolResult>();
    for (const it of state.items) {
      if (it.kind === "tool_call") calls.add(it.id);
      else if (it.kind === "tool_result") results.set(it.call_id, it);
    }
    const rows = state.items.filter((it) => it.kind !== "tool_result" || !calls.has(it.call_id));
    return { rows, results };
  }, [state.items]);

  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 72,
    overscan: 8,
  });

  const prevRows = useRef(0);
  useLayoutEffect(() => {
    const grew = rows.length > prevRows.current;
    if (anchor.current !== null) {
      // Older items were prepended: keep the previously-first row in view.
      const added = rows.length - prevRows.current;
      virt.scrollToIndex(Math.max(0, added), { align: "start" });
      anchor.current = null;
    } else if (forceBottom.current || (grew && atBottom.current)) {
      if (rows.length > 0) virt.scrollToIndex(rows.length - 1, { align: "end" });
      forceBottom.current = rows.length === 0;
      atBottom.current = true;
      setUnseen(false);
    } else if (grew) {
      setUnseen(true);
    }
    prevRows.current = rows.length;
  }, [rows.length, virt]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 40;
    if (atBottom.current) setUnseen(false);
    if (el.scrollTop <= 0 && !loadingOlder.current) {
      const before = state.total - state.items.length;
      if (before <= 0) return;
      loadingOlder.current = true;
      const gen = generation.current;
      chatPage(pane, before)
        .then((older) => {
          if (gen !== generation.current || older.length === 0) return;
          anchor.current = 0;
          dispatch({ type: "prepend", items: older });
        })
        .catch((e) => console.error("chat_page failed", e))
        .finally(() => {
          loadingOlder.current = false;
        });
    }
  };

  const jumpBottom = () => {
    if (rows.length > 0) virt.scrollToIndex(rows.length - 1, { align: "end" });
    atBottom.current = true;
    setUnseen(false);
  };

  const err = openError ?? state.error;
  return (
    <div className="chat-lens">
      {located && <TranscriptPicker located={located} onChoose={choose} />}
      {err && <div className="chat-notice chat-error">{err.code}: {err.message}</div>}
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div style={{ height: virt.getTotalSize(), position: "relative" }}>
          {virt.getVirtualItems().map((v) => {
            const item = rows[v.index];
            return (
              <div
                key={v.key}
                data-index={v.index}
                ref={virt.measureElement}
                style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${v.start}px)` }}
              >
                <ChatItemView item={item} result={item.kind === "tool_call" ? results.get(item.id) : undefined} />
              </div>
            );
          })}
        </div>
      </div>
      {unseen && (
        <button className="chat-new" onClick={jumpBottom}>
          ↓ New messages
        </button>
      )}
      {view.status === "blocked" ? <BlockedPanel pane={pane} view={view} /> : <Composer pane={pane} />}
    </div>
  );
}

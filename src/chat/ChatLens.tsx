import { Channel } from "@tauri-apps/api/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { chatLocate, chatPage } from "../lib/ipc";
import { paneKey, type AppError, type ChatEvent, type ChatItem, type Located, type PaneRef, type PaneView } from "../lib/types";
import { useApp } from "../store/app";
import { onOpenFailure, openChat, watchMachine } from "./chatSession";
import { PromptPanel } from "./PromptPanel";
import { pendingQuestions } from "./prompt/askedPreviews";
import { emptyChat, prepend, reduce, type ChatState } from "./chatStore";
import { ChatItemView } from "./ChatItemView";
import { ChatOpenContext, ChatPaneContext, revokeChatImages } from "./images";
import { WorkBlockView } from "./WorkBlockView";
import { buildRows } from "./workBlocks";
import { ChatOutline } from "./ChatOutline";
import { currentEntry, outline } from "./outline";
import { Composer } from "./Composer";
import { WorkingIndicator } from "./WorkingIndicator";
import { usePiModelPicker } from "./usePiModelPicker";
import { usePendingTranscript } from "./pendingTranscript";
import { ArrowDownIcon } from "../ui/icons";
import { forgetTranscript, rememberedTranscript, rememberTranscript, TranscriptPicker } from "./TranscriptPicker";

/** How long an open that has not answered yet may go without saying the transcript is loading. */
const LOADING_DELAY = 150;

type Action = (ChatEvent & { atBottom?: boolean }) | { type: "prepend"; items: ChatItem[]; before: number };
const reducer = (s: ChatState, a: Action): ChatState => (a.type === "prepend" ? prepend(s, a.items, a.before) : reduce(s, a, a.atBottom));

export function ChatLens({ pane, view }: { pane: PaneRef; view: PaneView }) {
  const key = paneKey(pane);
  const setLensOverride = useApp((s) => s.setLensOverride);
  const machineState = useApp((s) => s.machines[pane.machine_id]?.state);
  const sawDown = useRef(false);
  const [state, dispatch] = useReducer(reducer, emptyChat);
  const latest = useRef(state);
  latest.current = state;
  const [located, setLocated] = useState<Located | null>(null);
  const [openError, setOpenError] = useState<AppError | null>(null);
  const [unseen, setUnseen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const loadingOlder = useRef(false);
  const anchor = useRef<number | null>(null);
  const forceBottom = useRef(true);
  const generation = useRef(0);
  const handle = useRef<{ close: () => void } | null>(null);
  // Bumped on each `reset`: thumbnails that failed while the tail was gone ask again.
  const [opened, setOpened] = useState(0);
  // The first Reset waits for the whole backlog (seconds over a slow ssh): say so meanwhile.
  const [loaded, setLoaded] = useState(false);
  // Held back while the open may be a reattach to the running tail, whose Reset comes at once:
  // shown once the open turns out to have located, or after `LOADING_DELAY` without an answer.
  const [loadingShown, setLoadingShown] = useState(false);
  const loadingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Work blocks the user opened or closed, by block id: a virtualized row forgets its own state.
  const [chosenOpen, setChosenOpen] = useState<ReadonlyMap<string, boolean>>(new Map());
  // The turn picked in the rail stays lit until the user scrolls: near the end it may not reach
  // the top, and the end rule would light the last turn instead.
  const [picked, setPicked] = useState<string | null>(null);
  // The Pane `/model` was sent to: pi waits on its picker idle, so the picker is looked for then.
  const [modelFor, setModelFor] = useState<string | null>(null);
  const picker = usePiModelPicker(pane, modelFor === key && view.agent === "pi", () => setModelFor(null));
  useEffect(() => setModelFor(null), [key]);

  // `known`: where `path` was located, when the caller already knows (kept over what opening returns).
  const open = useCallback(
    (path: string | null, known?: Located) => {
      const gen = ++generation.current;
      setOpenError(null);
      setLoaded(false);
      setLoadingShown(false);
      clearTimeout(loadingTimer.current);
      loadingTimer.current = setTimeout(() => {
        if (gen === generation.current) setLoadingShown(true);
      }, LOADING_DELAY);
      const channel = new Channel<ChatEvent>();
      channel.onmessage = (ev) => {
        if (gen !== generation.current) return;
        if (ev.type === "reset" || ev.type === "error") setLoaded(true);
        if (ev.type === "reset") {
          forceBottom.current = true;
          setOpened((n) => n + 1);
        }
        dispatch(ev.type === "append" ? { ...ev, atBottom: atBottom.current } : ev);
      };
      handle.current?.close();
      const h = openChat(pane, path, channel);
      handle.current = h;
      h.opened
        .then((l) => {
          if (gen !== generation.current || !l) return;
          setLocated(known ?? l);
          clearTimeout(loadingTimer.current);
          if (!l.cached) setLoadingShown(true);
          // Reopened on the running tail without locating: the agent may since have moved on to
          // another transcript, so locate it now, off the open's path.
          if (l.cached && path === null) {
            chatLocate(pane).then(
              (fresh) => {
                if (gen !== generation.current) return;
                if (fresh.path !== l.path) open(fresh.path, fresh);
                else setLocated(fresh);
              },
              () => {},
            );
          }
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
              // In memory only: a fresh pane's transcript appears after its first prompt, and
              // useTranscriptProbe returns to Chat then when new agents open on Chat.
              setLensOverride(key, "terminal");
              break;
            case "error":
              setOpenError(e);
          }
        });
    },
    [pane, key, setLensOverride],
  );

  // The tail dies with an ssh drop: reopen once the Machine is back.
  useEffect(() => {
    const w = watchMachine(sawDown.current, machineState);
    sawDown.current = w.sawDown;
    if (w.reopen) open(rememberedTranscript(key));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineState]);

  useEffect(() => {
    setChosenOpen(new Map());
    setPicked(null);
    setLocated(null);
    open(rememberedTranscript(key));
    return () => {
      generation.current++;
      handle.current?.close();
      handle.current = null;
      clearTimeout(loadingTimer.current);
      revokeChatImages(key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // A new Claude has no transcript until its first prompt: chat with it on the expected path.
  const pending = !!located?.pending && state.items.length === 0;
  usePendingTranscript(pane, located, state.items.length === 0, view.status, () => open(null));

  const choose = (path: string) => {
    rememberTranscript(key, path);
    open(path);
  };

  // Tool results render inside their call; each turn's work folds into one row.
  const { rows, results } = useMemo(() => buildRows(state.items, state.total - state.items.length), [state.items, state.total]);
  const asked = useMemo(() => pendingQuestions(state.items), [state.items]);
  const toggle = useCallback((id: string, wasOpen: boolean) => {
    setChosenOpen((m) => new Map(m).set(id, !wasOpen));
  }, []);
  const live = view.status === "working" || view.status === "blocked";

  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 72,
    overscan: 8,
    getItemKey: (i) => rows[i].key,
  });

  const prevRows = useRef(0);
  const prevItems = useRef(0);
  useLayoutEffect(() => {
    // Items, not rows: a tool call joining the live work block grows that row, not the count.
    const grew = state.items.length > prevItems.current;
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
    prevItems.current = state.items.length;
  }, [rows.length, state.items.length, virt]);

  // Rows measure taller than their estimate after the jump, and the working indicator
  // shrinks the viewport: neither fires a scroll event, so stay pinned while at the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current && anchor.current === null) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

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
          // A trim or reset since the fetch moved the window: the reducer drops the page, so
          // leave no anchor behind for it.
          const now = latest.current;
          if (now.total - now.items.length !== before) return;
          anchor.current = 0;
          dispatch({ type: "prepend", items: older, before });
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

  // The outline rail follows the first row in view, or the last turn once at the end.
  const entries = useMemo(() => outline(rows), [rows]);
  const scrollTop = virt.scrollOffset ?? 0;
  const topRow = virt.getVirtualItems().find((v) => v.end > scrollTop)?.index ?? 0;
  const atEnd = rows.length > 0 && scrollTop + (virt.scrollRect?.height ?? 0) >= virt.getTotalSize() - 40;
  const pickedAt = picked === null ? -1 : entries.findIndex((e) => e.key === picked);
  const current = pickedAt >= 0 ? pickedAt : currentEntry(entries, topRow, atEnd);
  const unpick = () => setPicked(null);
  // Off the bottom before the scroll lands: an append meanwhile would pull the view back down.
  const jumpTo = (row: number) => {
    atBottom.current = false;
    setPicked(entries.find((e) => e.row === row)?.key ?? null);
    virt.scrollToIndex(row, { align: "start" });
  };

  const err = openError ?? state.error;
  return (
    <ChatPaneContext.Provider value={pane}>
    <ChatOpenContext.Provider value={opened}>
    <div className="chat-lens">
    <div className="chat-main">
      {located && <TranscriptPicker located={located} onChoose={choose} />}
      {err && <div className="chat-notice chat-error">{err.code}: {err.message}</div>}
      {pending && !err && <div className="chat-notice neutral">New conversation: send the first message to start it.</div>}
      {!loaded && loadingShown && !pending && !err && <div className="chat-notice neutral">Loading transcript…</div>}
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll} onWheel={unpick} onPointerDown={unpick} onKeyDown={unpick}>
        <div ref={contentRef} style={{ height: virt.getTotalSize(), position: "relative" }}>
          {virt.getVirtualItems().map((v) => {
            const row = rows[v.index];
            return (
              <div
                key={v.key}
                data-index={v.index}
                ref={virt.measureElement}
                style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${v.start}px)` }}
              >
                {row.kind === "work" ? (
                  <WorkBlockView
                    block={row.block}
                    results={results}
                    open={chosenOpen.get(row.block.id) ?? row.last}
                    onToggle={toggle}
                    live={live && row.last}
                  />
                ) : (
                  <ChatItemView
                    item={row.item}
                    copy
                    result={row.item.kind === "tool_call" ? results.get(row.item.id) : undefined}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
      {unseen && (
        <button className="chat-new" onClick={jumpBottom}>
          <ArrowDownIcon /> New messages
        </button>
      )}
      <WorkingIndicator status={view.status} />
      {view.status === "blocked" || picker.open ? (
        <PromptPanel pane={pane} view={view} fallback={view.status === "blocked"} asked={asked} />
      ) : (
        <Composer pane={pane} agent={view.agent} status={view.status} onPiModel={() => setModelFor(key)} meta={state.meta} />
      )}
    </div>
    <ChatOutline entries={entries} current={current} onJump={jumpTo} />
    </div>
    </ChatOpenContext.Provider>
    </ChatPaneContext.Provider>
  );
}

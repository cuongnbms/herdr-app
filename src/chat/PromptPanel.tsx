import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useRef, useState } from "react";
import "../fonts/fonts.css";
import { herdrCall } from "../lib/ipc";
import { paneKey, type PaneRef, type PaneView } from "../lib/types";
import { useApp } from "../store/app";
import { watchTermFont } from "../settings/store";
import { watchTermTheme } from "../settings/theme";
import { applyUnicode11 } from "../terminal/unicode";
import { parseInteractivePrompt, readPrompt, type PromptAnswer, type ScreenPrompt } from "./prompt/screenPrompt";
import { sendAnswer, type PromptIo } from "./prompt/sendAnswer";

const QUICK: { label: string; key: string }[] = [
  { label: "1", key: "1" },
  { label: "2", key: "2" },
  { label: "3", key: "3" },
  { label: "Enter", key: "enter" },
  { label: "Esc", key: "esc" },
  { label: "↑", key: "up" },
  { label: "↓", key: "down" },
];

/** How often the visible screen is re-read while the agent waits: a multi-question form moves on without a status change. */
export const PROMPT_POLL_MS = 1500;
/** Time for the TUI to redraw after an answer before the screen is read again. */
const SETTLE_MS = 250;

const RECOMMENDED_RE = /\s*\(Recommended\)$/i;

interface ReadResult {
  text?: string;
  read?: { text?: string };
}

const message = (e: unknown) => (e as { message?: string })?.message ?? String(e);

/** The read-only mirror of the pane's visible screen, for what the card cannot read. */
function ScreenMirror({ text }: { text: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      disableStdin: true,
      cursorBlink: false,
      scrollback: 200,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Same widths as the pane it mirrors.
    applyUnicode11(term);
    const unwatchFont = watchTermFont(term, fit, -1);
    const unwatchTheme = watchTermTheme(term);
    term.open(host);
    termRef.current = term;
    try {
      fit.fit();
    } catch {
      /* not measurable yet */
    }
    return () => {
      termRef.current = null;
      unwatchFont();
      unwatchTheme();
      term.dispose();
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.reset();
    term.write(text.replace(/\r?\n/g, "\r\n"));
  }, [text]);

  return <div className="blocked-screen" ref={hostRef} />;
}

/** One prompt as buttons, checkboxes and a text field. Keyed by the prompt's id, so a new prompt starts blank. */
function PromptCard({
  prompt,
  pending,
  onAnswer,
}: {
  prompt: ScreenPrompt;
  pending: boolean;
  onAnswer: (answer: PromptAnswer) => void;
}) {
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [custom, setCustom] = useState("");
  const toggle = (i: number) =>
    setChecked((cur) => {
      const next = new Set(cur);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const submitCustom = () => {
    if (custom.trim()) onAnswer({ custom_text: custom.trim() });
  };

  return (
    <>
      <div className="blocked-head">
        <span className="dot dot-blocked" aria-hidden="true" />
        <span className="prompt-title">{prompt.title}</span>
      </div>
      {prompt.question !== prompt.title && <p className="prompt-question">{prompt.question}</p>}
      {prompt.body && <pre className="prompt-body">{prompt.body}</pre>}
      <div
        className={"prompt-options" + (prompt.fallback ? " keys" : "")}
        role={prompt.multi_select ? "group" : undefined}
        aria-label={prompt.multi_select ? prompt.question : undefined}
      >
        {prompt.options.map((option, i) => {
          const recommended = RECOMMENDED_RE.test(option.label);
          const content = (
            <span className="prompt-option-text">
              <span className="prompt-option-label">
                {option.label.replace(RECOMMENDED_RE, "")}
                {recommended && <span className="prompt-tag">Recommended</span>}
              </span>
              {option.description && <span className="prompt-option-desc">{option.description}</span>}
            </span>
          );
          if (prompt.multi_select) {
            return (
              <label key={i} className={"prompt-option" + (checked.has(i) ? " checked" : "")}>
                <input type="checkbox" checked={checked.has(i)} disabled={pending} onChange={() => toggle(i)} />
                {content}
              </label>
            );
          }
          return (
            <button
              key={i}
              type="button"
              className={prompt.fallback ? "keycap" : "prompt-option"}
              disabled={pending}
              onClick={() => onAnswer({ option_index: i })}
            >
              {!prompt.fallback && <span className="prompt-num">{i + 1}</span>}
              {prompt.fallback ? option.label : content}
            </button>
          );
        })}
      </div>
      {prompt.multi_select && (
        <button
          type="button"
          className={"btn" + (checked.size > 0 ? " btn-primary" : "") + " prompt-submit"}
          disabled={pending || checked.size === 0}
          onClick={() => onAnswer({ option_indices: [...checked].sort((a, b) => a - b) })}
        >
          {checked.size > 0 ? `Submit (${checked.size})` : "Submit"}
        </button>
      )}
      {prompt.custom_option_index !== null && (
        <div className="prompt-custom">
          <input
            value={custom}
            disabled={pending}
            aria-label="Your own answer"
            placeholder={prompt.kind === "plan" ? "Tell Claude what to change" : "Or type your own answer"}
            onChange={(e) => setCustom(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submitCustom();
              }
            }}
          />
          <button
            type="button"
            className={"btn" + (custom.trim() ? " btn-primary" : "")}
            disabled={pending || !custom.trim()}
            onClick={submitCustom}
          >
            Send
          </button>
        </div>
      )}
    </>
  );
}

/**
 * What the Chat lens shows while the Agent is blocked: the prompt on its screen (a question,
 * an approval, a plan to accept) read into a card that answers it with the keys the TUI
 * expects, and the screen itself for whatever the card cannot read. With `fallback` off (a
 * prompt the Agent waits on while idle, such as pi's model picker), only a known reader's card
 * shows: a screen none of them reads keeps the last card rather than guess at keys.
 */
export function PromptPanel({ pane, view, fallback = true }: { pane: PaneRef; view: PaneView; fallback?: boolean }) {
  const agent = view.agent;
  const [screenText, setScreenText] = useState("");
  const [prompt, setPrompt] = useState<ScreenPrompt | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showScreen, setShowScreen] = useState(false);
  const setLens = useApp((s) => s.setLens);
  const busy = useRef(false);
  const live = useRef(true);

  const call = useCallback(
    (method: string, params: unknown) => herdrCall(pane.machine_id, pane.session, method, params),
    [pane.machine_id, pane.session],
  );
  // The readers are written against herdr's plain-text read; the mirror alone wants the colors.
  const readAs = useCallback(
    (format: "text" | "ansi") =>
      call("pane.read", { pane_id: pane.pane_id, source: "visible", format, strip_ansi: format === "text" }).then(
        (r) => (r as ReadResult | undefined)?.text ?? (r as ReadResult | undefined)?.read?.text ?? "",
      ),
    [call, pane.pane_id],
  );
  const read = useCallback(() => readAs("text"), [readAs]);
  const show = useCallback(
    (text: string) => {
      if (!live.current) return;
      const next = fallback ? readPrompt(agent, text) : parseInteractivePrompt(agent ?? "", text);
      // the same prompt keeps its card (and what was ticked or typed on it)
      setPrompt((cur) => (next === null || cur?.id === next.id ? cur : next));
      return next;
    },
    [agent, fallback],
  );
  const mirrorOn = useRef(false);
  const refresh = useCallback(
    () =>
      read()
        .then(async (text) => {
          const next = show(text);
          if (mirrorOn.current || next?.fallback) {
            const ansi = await readAs("ansi");
            if (live.current) setScreenText(ansi);
          }
        })
        .catch((e) => console.error("pane.read failed", e)),
    [read, readAs, show],
  );

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // Read on mount, on every status update, and on a timer while waiting.
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (!busy.current) void refresh();
    }, PROMPT_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh, view.status, view.title]);

  const io: PromptIo = {
    read,
    keys: (keys) => call("agent.send_keys", { target: pane.pane_id, keys }),
    text: (text) => call("pane.send_text", { pane_id: pane.pane_id, text }),
  };

  const answer = async (a: PromptAnswer) => {
    if (!prompt || busy.current) return;
    busy.current = true;
    setPending(true);
    try {
      const outcome = await sendAnswer(io, agent, prompt, a, undefined, fallback);
      if (outcome.sent) {
        setError(null);
        await new Promise((r) => setTimeout(r, SETTLE_MS));
      } else {
        setError("The prompt changed on screen. Check it and answer again.");
        const fresh = outcome.fresh;
        if (fresh) setPrompt(fresh);
      }
      await refresh();
    } catch (e) {
      console.error("prompt answer failed", e);
      setError(`Send failed: ${message(e)}`);
    } finally {
      busy.current = false;
      if (live.current) setPending(false);
    }
  };

  const sendKey = (key: string) =>
    void io.keys([key]).then(
      () => setError(null),
      (e) => {
        console.error("send_keys failed", e);
        setError(`Send failed: ${message(e)}`);
      },
    );

  const screenOpen = showScreen || !!prompt?.fallback;
  mirrorOn.current = screenOpen;
  // Opening the mirror reads the screen now rather than at the next poll.
  useEffect(() => {
    if (showScreen) void refresh();
  }, [showScreen, refresh]);
  return (
    <div className="blocked-panel" aria-busy={pending}>
      {prompt ? (
        <PromptCard key={prompt.id} prompt={prompt} pending={pending} onAnswer={(a) => void answer(a)} />
      ) : (
        <div className="blocked-head">
          <span className="dot dot-blocked" aria-hidden="true" />
          The agent is waiting for input
        </div>
      )}
      {error && <div className="chat-error" role="alert">{error}</div>}
      {screenOpen && <ScreenMirror text={screenText} />}
      <div className="blocked-keys">
        {screenOpen &&
          QUICK.map((k) => (
            <button key={k.key} className="keycap" onClick={() => sendKey(k.key)}>
              {k.label}
            </button>
          ))}
        <span className="blocked-open">
          {!prompt?.fallback && (
            <button className="btn btn-xs" aria-pressed={showScreen} onClick={() => setShowScreen((s) => !s)}>
              {showScreen ? "Hide screen" : "Show screen"}
            </button>
          )}
          <button className="btn btn-xs" onClick={() => setLens(paneKey(pane), "terminal")}>
            Open Terminal lens
          </button>
        </span>
      </div>
    </div>
  );
}

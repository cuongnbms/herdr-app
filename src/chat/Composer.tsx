import { useEffect, useMemo, useRef, useState } from "react";
import { herdrCall, imageSaveTemp } from "../lib/ipc";
import { paneKey, type AgentStatus, type ChatMeta, type PaneRef, type SlashCommand } from "../lib/types";
import { quickReplyButtons, useQuickReplies } from "../settings/quickReplies";
import { CloseIcon, SendIcon, StopIcon } from "../ui/icons";
import { CompletionMenu } from "./CompletionMenu";
import { GitStatusLine } from "./GitStatus";
import { rankCommands, rankFiles, readUsage, recordUse } from "./complete";
import { readDraft, useDraft } from "./drafts";
import { activeTrigger, applyCompletion } from "./mentions";
import { modelLabel } from "./modelLabel";
import { ModelMenu } from "./ModelMenu";
import { useClaudeSuggestion } from "./useClaudeSuggestion";
import { useCompletions } from "./useCompletions";
import { IMAGE_EXTS } from "../terminal/imagePaste";

// Key names verified against herdr's key parser (pane.send_keys accepts esc, ctrl+c,
// shift+tab, enter, up, down, 1; unknown names fail with `invalid_key`).
const KEYS: { label: string; key: string }[] = [
  { label: "Esc", key: "esc" },
  { label: "Ctrl+C", key: "ctrl+c" },
  { label: "⇧Tab", key: "shift+tab" },
];

// Agents whose TUI turns a bracketed-pasted image path into an image attachment (as when
// pasting a screenshot in a terminal); `agent.prompt` frames text and path as one paste,
// so each path goes first on its own. Other agents get an `@path` file mention.
const PATH_PASTE_AGENTS = new Set(["claude", "codex", "gemini"]);

// Claude Code attaches a pasted image path asynchronously; submitting sooner can drop the
// image (herdr likewise holds `agent.prompt`'s Enter back 300 ms behind its text).
export const IMAGE_SETTLE_MS = 300;

// Agents whose Slash commands the Composer can list.
const SLASH_AGENTS = new Set(["claude", "pi", "codex"]);

// pi's /model opens a picker in the terminal; `/model <name>` may switch without one.
const PI_MODEL_RE = /^\/model(\s|$)/;

const bracketedPaste = (text: string) => `\x1b[200~${text}\x1b[201~`;
const mention = (path: string) => (/[\s"]/.test(path) ? `@"${path}"` : `@${path}`);

interface Attachment {
  id: number;
  preview: string;
  /** Path on the pane's Machine; null while the save is in flight. */
  path: string | null;
}

const revoke = (a: Attachment) => {
  if (a.preview) URL.revokeObjectURL(a.preview);
};

export function Composer({
  pane,
  agent,
  status,
  onPiModel,
  meta,
}: {
  pane: PaneRef;
  agent: string | null;
  status?: AgentStatus;
  /** Called once `/model` has gone to pi, whose picker the Chat lens then shows as a card. */
  onPiModel?: () => void;
  meta?: ChatMeta;
}) {
  const key = paneKey(pane);
  const [text, setText] = useState(() => readDraft(key));
  const [images, setImages] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const [usage, setUsage] = useState<Record<string, number>>(() => (agent ? readUsage(agent) : {}));
  const box = useRef<HTMLTextAreaElement>(null);
  const nextId = useRef(0);
  const live = useRef<Attachment[]>([]);
  live.current = images;
  useEffect(() => () => live.current.forEach(revoke), []);

  useEffect(() => setUsage(agent ? readUsage(agent) : {}), [agent]);
  // Sending clears the text and a failed send restores it, so the draft follows both.
  useDraft(key, text);

  const [sending, setSending] = useState(false);
  // Read only while the box is empty (that is when the suggestion shows, and Tab takes it), and
  // not while a send is on its way: Claude's box would still show the old suggestion.
  const { suggestion, clear: clearSuggestion } = useClaudeSuggestion(pane, agent, status, text === "" && !sending);
  const offered = text === "" ? suggestion : null;
  const label = modelLabel(meta);
  // Where the model menu opens from; null while it is closed.
  const [menuAt, setMenuAt] = useState<DOMRect | null>(null);
  const showQuick = useQuickReplies((s) => s.show);
  const quickReplies = quickReplyButtons(useQuickReplies((s) => s.replies));

  const found = activeTrigger(text, caret, { skills: agent === "codex" });
  const trigger = found && (found.kind === "file" || (agent && SLASH_AGENTS.has(agent))) ? found : null;
  const query = trigger?.query;
  const kind = trigger?.kind ?? null;
  const prefix = trigger?.prefix ?? "/";
  const { commands, files, loading, error: listError } = useCompletions(pane, kind);
  // Up to thousands of paths: rank them only when the list or the query changes.
  const fileRows = useMemo(() => (kind === "file" ? rankFiles(files, query ?? "") : []), [kind, files, query]);
  const rows: (SlashCommand | string)[] =
    kind === "slash"
      ? rankCommands(
          commands.filter((c) => (c.trigger === "$") === (prefix === "$")),
          query ?? "",
          usage,
        )
      : fileRows;
  useEffect(() => setActive(0), [kind, prefix, query]);
  const open = trigger !== null && !dismissed && (loading || listError || rows.length > 0);
  const capturing = open && rows.length > 0;
  const current = Math.min(active, Math.max(rows.length - 1, 0));

  const choose = (i: number) => {
    const row = rows[i];
    if (!trigger || row === undefined) return;
    const insert = typeof row === "string" ? mention(row) : `${prefix}${row.name}`;
    const next = applyCompletion(text, trigger, `${insert} `);
    setText(next.text);
    setCaret(next.caret);
    setDismissed(false);
    if (typeof row !== "string" && agent) setUsage(recordUse(agent, row.name));
    requestAnimationFrame(() => box.current?.setSelectionRange(next.caret, next.caret));
  };

  const call = (method: string, params: unknown) =>
    herdrCall(pane.machine_id, pane.session, method, params).then(
      () => setError(null),
      (e) => {
        console.error(method, "failed", e);
        setError(`Send failed: ${e?.message ?? String(e)}`);
        return Promise.reject(e);
      },
    );

  const attach = async (file: File) => {
    const ext = IMAGE_EXTS[file.type];
    if (!ext) {
      setError(`Image paste failed: ${file.type} is not supported`);
      return;
    }
    const id = nextId.current++;
    const preview = typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : "";
    setImages((cur) => [...cur, { id, preview, path: null }]);
    try {
      const path = await imageSaveTemp(pane.machine_id, new Uint8Array(await file.arrayBuffer()), ext);
      setImages((cur) => cur.map((a) => (a.id === id ? { ...a, path } : a)));
    } catch (e) {
      console.error("image_save_temp failed", e);
      setError(`Image paste failed: ${(e as { message?: string })?.message ?? String(e)}`);
      setImages((cur) => {
        cur.filter((a) => a.id === id).forEach(revoke);
        return cur.filter((a) => a.id !== id);
      });
    }
  };

  const remove = (id: number) =>
    setImages((cur) => {
      cur.filter((a) => a.id === id).forEach(revoke);
      return cur.filter((a) => a.id !== id);
    });

  const uploading = images.some((a) => a.path === null);
  const canSend = !uploading && (text.trim() !== "" || images.length > 0);

  const submit = async (sent: string, paths: string[]) => {
    const target = pane.pane_id;
    if (paths.length === 0) return call("agent.prompt", { target, text: sent });
    if (agent && PATH_PASTE_AGENTS.has(agent)) {
      for (const path of paths) await call("pane.send_text", { pane_id: target, text: bracketedPaste(path) });
      await new Promise((r) => setTimeout(r, IMAGE_SETTLE_MS));
      return sent.trim()
        ? call("agent.prompt", { target, text: sent })
        : call("agent.send_keys", { target, keys: ["enter"] });
    }
    const mentions = paths.map(mention).join(" ");
    return call("agent.prompt", { target, text: sent.trim() ? `${mentions} ${sent}` : mentions });
  };

  const send = () => {
    if (!canSend) return;
    const sent = text;
    const sentImages = images;
    setText("");
    setImages([]);
    // The suggestion was for the turn this send answers.
    clearSuggestion();
    setSending(true);
    // Optimistic clear; restore the draft if the prompt did not go through (unless the user typed meanwhile).
    submit(sent, sentImages.map((a) => a.path as string))
      .then(
        () => {
          sentImages.forEach(revoke);
          if (agent === "pi" && PI_MODEL_RE.test(sent.trim())) onPiModel?.();
        },
        () => {
          setText((cur) => (cur === "" ? sent : cur));
          setImages((cur) => (cur.length === 0 ? sentImages : (sentImages.forEach(revoke), cur)));
        },
      )
      .finally(() => setSending(false));
  };

  /** A canned reply goes straight out; what is typed in the box stays a draft. */
  const sendQuick = (reply: string) => {
    if (sending) return;
    clearSuggestion();
    setSending(true);
    call("agent.prompt", { target: pane.pane_id, text: reply })
      .catch(() => {})
      .finally(() => setSending(false));
  };

  return (
    <div className="composer">
      {showQuick && quickReplies.length > 0 && (
        <div className="composer-quick" role="group" aria-label="Quick replies">
          {quickReplies.map((reply, i) => (
            <button key={`${i}:${reply}`} className="composer-quick-reply" title={`Send “${reply}”`} disabled={sending} onClick={() => sendQuick(reply)}>
              {reply}
            </button>
          ))}
        </div>
      )}
      <div className="composer-box">
        {images.length > 0 && (
          <div className="composer-images">
            {images.map((a, i) => (
              <div key={a.id} className={`composer-image${a.path === null ? " saving" : ""}`}>
                <img src={a.preview || undefined} alt={`Pasted image ${i + 1}`} />
                <button className="composer-image-remove" aria-label={`Remove image ${i + 1}`} onClick={() => remove(a.id)}>
                  <CloseIcon />
                </button>
              </div>
            ))}
          </div>
        )}
        {open && trigger && kind && (
          <CompletionMenu
            kind={kind}
            prefix={prefix}
            items={rows}
            active={current}
            loading={loading}
            error={listError}
            onChoose={choose}
          />
        )}
        <textarea
          ref={box}
          value={text}
          rows={2}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          placeholder={
            offered
              ? `${offered}  (Tab to use)`
              : "Message the agent…  (Enter to send, Shift+Enter for newline, paste images)"
          }
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
            setDismissed(false);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
            if (files.length === 0) return;
            // Text that came with the image still lands in the textarea.
            if (!e.clipboardData.getData("text/plain")) e.preventDefault();
            files.forEach((f) => void attach(f));
          }}
          onKeyDown={(e) => {
            // Escape closes any open list, a loading or failed one included.
            if (open && e.key === "Escape" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              return setDismissed(true);
            }
            if (capturing && !e.nativeEvent.isComposing) {
              const move = (by: number) => {
                e.preventDefault();
                setActive((current + by + rows.length) % rows.length);
              };
              if (e.key === "ArrowDown") return move(1);
              if (e.key === "ArrowUp") return move(-1);
              // Shift+Enter keeps its newline.
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                return choose(current);
              }
            }
            // After the completion list: Tab takes the suggestion into the empty box, as in Claude's own input.
            if (offered && e.key === "Tab" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              setText(offered);
              setCaret(offered.length);
              requestAnimationFrame(() => box.current?.setSelectionRange(offered.length, offered.length));
              return;
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-bar">
          <div className="composer-keys">
            {KEYS.map((k) => (
              <button key={k.key} className="keycap" onClick={() => call("agent.send_keys", { target: pane.pane_id, keys: [k.key] }).catch(() => {})}>
                {k.label}
              </button>
            ))}
          </div>
          <GitStatusLine pane={pane} status={status} />
          {agent === "claude" ? (
            // Claude takes /model and /effort with an argument; only while idle, since a turn would
            // queue them and a blocked prompt would take the text as its answer.
            <button
              className="composer-model"
              title="Model · reasoning effort · context tokens"
              aria-haspopup="menu"
              aria-expanded={menuAt !== null}
              disabled={status === "working" || status === "blocked"}
              onClick={(e) => setMenuAt(e.currentTarget.getBoundingClientRect())}
            >
              {label ?? "Model"}
            </button>
          ) : (
            label && (
              <span className="composer-model" title="Model · reasoning effort · context tokens">
                {label}
              </span>
            )
          )}
          {/* Esc interrupts the agent's turn without killing it the way Ctrl+C can. Send stays
              usable beside it: the agent queues text sent while it works. */}
          {status === "working" && (
            <button className="stop" aria-label="Stop" title="Stop (Esc)" onClick={() => call("agent.send_keys", { target: pane.pane_id, keys: ["esc"] }).catch(() => {})}>
              <StopIcon />
            </button>
          )}
          <button className="send" aria-label="Send" disabled={!canSend} onClick={send}>
            <SendIcon />
          </button>
          {menuAt && (
            <ModelMenu
              anchor={menuAt}
              meta={meta}
              onPick={sendQuick}
              onClose={() => setMenuAt(null)}
            />
          )}
        </div>
      </div>
      {error && <div className="chat-error composer-error" role="alert">{error}</div>}
    </div>
  );
}

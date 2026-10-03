import { useEffect, useRef, useState } from "react";
import { herdrCall, imageSaveTemp } from "../lib/ipc";
import type { PaneRef } from "../lib/types";
import { CloseIcon, SendIcon } from "../ui/icons";

// Key names verified against herdr's key parser (pane.send_keys accepts esc, ctrl+c,
// shift+tab, enter, up, down, 1; unknown names fail with `invalid_key`).
const KEYS: { label: string; key: string }[] = [
  { label: "Esc", key: "esc" },
  { label: "Ctrl+C", key: "ctrl+c" },
  { label: "⇧Tab", key: "shift+tab" },
];

const IMAGE_EXTS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

// Agents whose TUI turns a bracketed-pasted image path into an image attachment (as when
// pasting a screenshot in a terminal); `agent.prompt` frames text and path as one paste,
// so each path goes first on its own. Other agents get an `@path` file mention.
const PATH_PASTE_AGENTS = new Set(["claude", "codex", "gemini"]);

// Claude Code attaches a pasted image path asynchronously; submitting sooner can drop the
// image (herdr likewise holds `agent.prompt`'s Enter back 300 ms behind its text).
export const IMAGE_SETTLE_MS = 300;

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

export function Composer({ pane, agent }: { pane: PaneRef; agent: string | null }) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const nextId = useRef(0);
  const live = useRef<Attachment[]>([]);
  live.current = images;
  useEffect(() => () => live.current.forEach(revoke), []);

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
    // Optimistic clear; restore the draft if the prompt did not go through (unless the user typed meanwhile).
    submit(sent, sentImages.map((a) => a.path as string)).then(
      () => sentImages.forEach(revoke),
      () => {
        setText((cur) => (cur === "" ? sent : cur));
        setImages((cur) => (cur.length === 0 ? sentImages : (sentImages.forEach(revoke), cur)));
      },
    );
  };

  return (
    <div className="composer">
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
        <textarea
          value={text}
          rows={2}
          placeholder="Message the agent…  (Enter to send, Shift+Enter for newline, paste images)"
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
            if (files.length === 0) return;
            // Text that came with the image still lands in the textarea.
            if (!e.clipboardData.getData("text/plain")) e.preventDefault();
            files.forEach((f) => void attach(f));
          }}
          onKeyDown={(e) => {
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
          <button className="send" aria-label="Send" disabled={!canSend} onClick={send}>
            <SendIcon />
          </button>
        </div>
      </div>
      {error && <div className="chat-error composer-error" role="alert">{error}</div>}
    </div>
  );
}

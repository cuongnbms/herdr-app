import { type CSSProperties, useEffect, useRef, useState } from "react";
import { notificationsEnabled, setNotificationsEnabled } from "../notify";
import { CloseIcon, GearIcon, SearchIcon } from "../ui/icons";
import { FontPicker } from "./FontPicker";
import { useLensSettings } from "./lens";
import { DEFAULT_QUICK_REPLIES, QUICK_REPLIES_MAX, QUICK_REPLY_MAX_CHARS, useQuickReplies } from "./quickReplies";
import { CHAT_SIZE, DEFAULTS, TERM_SIZE, useSettings } from "./store";
import { THEME_PREFS, useTheme } from "./theme";

/** How far one press of − or + moves a font size, in px. */
const SIZE_STEP = 0.5;

function Stepper({
  label,
  value,
  range,
  onChange,
}: {
  label: string;
  value: number;
  range: { min: number; max: number };
  onChange: (v: number) => void;
}) {
  return (
    <div className="setting-row">
      <span>{label}</span>
      <div className="stepper">
        <button aria-label={`Decrease ${label.toLowerCase()}`} disabled={value <= range.min} onClick={() => onChange(value - SIZE_STEP)}>
          −
        </button>
        <output>{value}px</output>
        <button aria-label={`Increase ${label.toLowerCase()}`} disabled={value >= range.max} onClick={() => onChange(value + SIZE_STEP)}>
          +
        </button>
      </div>
    </div>
  );
}

function GeneralSettings() {
  const [notify, setNotify] = useState(notificationsEnabled);
  return (
    <>
      <label className="switch">
        <span>Notifications</span>
        <input
          type="checkbox"
          role="switch"
          checked={notify}
          onChange={(e) => {
            setNotify(e.target.checked);
            setNotificationsEnabled(e.target.checked);
          }}
        />
      </label>
      <p className="note">
        For exact chat binding, run <code>herdr integration install claude</code> / <code>pi</code> on each machine.
      </p>
    </>
  );
}

function AppearanceSettings() {
  const pref = useTheme((s) => s.pref);
  const setPref = useTheme((s) => s.setPref);
  const i = THEME_PREFS.findIndex((t) => t.id === pref);
  return (
    <>
      <div className="setting-row">
        <span id="theme-label">Theme</span>
        <div
          className="seg seg-n"
          role="group"
          aria-labelledby="theme-label"
          style={{ "--n": THEME_PREFS.length, "--i": i } as CSSProperties}
        >
          <span className="seg-thumb" />
          {THEME_PREFS.map((t) => (
            <button key={t.id} aria-pressed={t.id === pref} onClick={() => setPref(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <p className="note">System follows the macOS appearance.</p>
    </>
  );
}

function FontSettings() {
  const s = useSettings();
  const isDefault =
    s.terminalFontFamily === DEFAULTS.terminalFontFamily &&
    s.terminalFontSize === DEFAULTS.terminalFontSize &&
    s.chatFontSize === DEFAULTS.chatFontSize;
  return (
    <>
      <FontPicker label="Terminal font" value={s.terminalFontFamily} onChange={(f) => s.set({ terminalFontFamily: f })} />
      <Stepper label="Terminal size" value={s.terminalFontSize} range={TERM_SIZE} onChange={(v) => s.set({ terminalFontSize: v })} />
      <Stepper label="Chat size" value={s.chatFontSize} range={CHAT_SIZE} onChange={(v) => s.set({ chatFontSize: v })} />
      <p className="note">Lists the monospace fonts installed on this Mac. JetBrains Mono is bundled and covers Vietnamese.</p>
      <div className="settings-foot">
        <button className="btn btn-xs" aria-label="Reset fonts" disabled={isDefault} onClick={s.reset}>
          Reset to defaults
        </button>
      </div>
    </>
  );
}

function ChatSettings() {
  const q = useQuickReplies();
  const lens = useLensSettings();
  const list = useRef<HTMLDivElement>(null);
  const added = useRef(false);
  // Focus the row just added, so typing goes straight into it.
  useEffect(() => {
    if (!added.current) return;
    added.current = false;
    list.current?.querySelector<HTMLInputElement>(".quick-reply-row:last-child input")?.focus();
  }, [q.replies.length]);
  const isDefault = q.replies.length === DEFAULT_QUICK_REPLIES.length && q.replies.every((r, i) => r === DEFAULT_QUICK_REPLIES[i]);
  return (
    <>
      <label className="switch">
        <span>Switch to Chat after the first prompt</span>
        <input
          type="checkbox"
          role="switch"
          checked={lens.chatAfterFirstPrompt}
          onChange={(e) => lens.setChatAfterFirstPrompt(e.target.checked)}
        />
      </label>
      <p className="note">A new agent opens on the Terminal. When on, it turns to Chat once its conversation starts; when off, it stays on the Terminal until you switch.</p>
      <label className="switch">
        <span>Quick replies</span>
        <input type="checkbox" role="switch" checked={q.show} onChange={(e) => q.setShow(e.target.checked)} />
      </label>
      <p className="note">Buttons above the message box that send a short reply in one click.</p>
      <div className="quick-reply-list" ref={list}>
        {q.replies.map((r, i) => (
          <div key={i} className="quick-reply-row">
            <input
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              aria-label={`Quick reply ${i + 1}`}
              value={r}
              maxLength={QUICK_REPLY_MAX_CHARS}
              placeholder="Reply text"
              onChange={(e) => q.setReplies(q.replies.map((x, j) => (j === i ? e.target.value : x)))}
            />
            <button className="icon-btn" aria-label={`Remove quick reply ${i + 1}`} onClick={() => q.setReplies(q.replies.filter((_, j) => j !== i))}>
              <CloseIcon />
            </button>
          </div>
        ))}
      </div>
      <div className="settings-foot">
        <button
          className="btn btn-xs"
          aria-label="Add quick reply"
          disabled={q.replies.length >= QUICK_REPLIES_MAX}
          onClick={() => {
            added.current = true;
            q.setReplies([...q.replies, ""]);
          }}
        >
          Add reply
        </button>
        <button className="btn btn-xs" aria-label="Reset quick replies" disabled={isDefault} onClick={q.reset}>
          Reset to defaults
        </button>
      </div>
    </>
  );
}

/** Add a section here for each new group of settings. */
const SECTIONS = [
  { id: "general", label: "General", Body: GeneralSettings },
  { id: "appearance", label: "Appearance", Body: AppearanceSettings },
  { id: "fonts", label: "Fonts", Body: FontSettings },
  { id: "chat", label: "Chat", Body: ChatSettings },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [active, setActive] = useState<SectionId>("general");
  const section = SECTIONS.find((x) => x.id === active) ?? SECTIONS[0];
  const ref = useRef<HTMLDivElement>(null);
  // Focus the dialog so Escape reaches it (autoFocus only applies to form controls).
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        ref={ref}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <nav className="settings-nav" role="tablist" aria-orientation="vertical">
          <div className="settings-nav-title">Settings</div>
          {SECTIONS.map((x) => (
            <button
              key={x.id}
              role="tab"
              aria-selected={x.id === active}
              className={x.id === active ? "active" : undefined}
              onClick={() => setActive(x.id)}
            >
              {x.label}
            </button>
          ))}
        </nav>
        <section className="settings-body" role="tabpanel" aria-label={section.label}>
          <header className="settings-head">
            <h3>{section.label}</h3>
            <button className="icon-btn" aria-label="Close settings" onClick={onClose}>
              ×
            </button>
          </header>
          <section.Body />
        </section>
      </div>
    </div>
  );
}

export function Settings() {
  const [open, setOpen] = useState(false);
  return (
    <div className="settings">
      {open && <SettingsDialog onClose={() => setOpen(false)} />}
      <button className="icon-btn" aria-label="Settings" aria-expanded={open} onClick={() => setOpen(true)}>
        <GearIcon />
      </button>
      <span className="settings-hint">
        <SearchIcon /> Jump <kbd>⌘K</kbd>
      </span>
    </div>
  );
}

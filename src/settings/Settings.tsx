import { useEffect, useRef, useState } from "react";
import { notificationsEnabled, setNotificationsEnabled } from "../notify";
import { GearIcon, SearchIcon } from "../ui/icons";
import { CHAT_SIZE, DEFAULTS, TERM_FAMILIES, TERM_SIZE, useSettings } from "./store";

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
        <button aria-label={`Decrease ${label.toLowerCase()}`} disabled={value <= range.min} onClick={() => onChange(value - 1)}>
          −
        </button>
        <output>{value}px</output>
        <button aria-label={`Increase ${label.toLowerCase()}`} disabled={value >= range.max} onClick={() => onChange(value + 1)}>
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

function FontSettings() {
  const s = useSettings();
  const families = TERM_FAMILIES.includes(s.terminalFontFamily) ? TERM_FAMILIES : [s.terminalFontFamily, ...TERM_FAMILIES];
  const isDefault =
    s.terminalFontFamily === DEFAULTS.terminalFontFamily &&
    s.terminalFontSize === DEFAULTS.terminalFontSize &&
    s.chatFontSize === DEFAULTS.chatFontSize;
  return (
    <>
      <label className="setting-row">
        <span>Terminal font</span>
        <select value={s.terminalFontFamily} onChange={(e) => s.set({ terminalFontFamily: e.target.value })}>
          {families.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>
      <Stepper label="Terminal size" value={s.terminalFontSize} range={TERM_SIZE} onChange={(v) => s.set({ terminalFontSize: v })} />
      <Stepper label="Chat size" value={s.chatFontSize} range={CHAT_SIZE} onChange={(v) => s.set({ chatFontSize: v })} />
      <p className="note">JetBrains Mono is bundled; other fonts must be installed on this Mac.</p>
      <div className="settings-foot">
        <button className="btn btn-xs" aria-label="Reset fonts" disabled={isDefault} onClick={s.reset}>
          Reset to defaults
        </button>
      </div>
    </>
  );
}

/** Add a section here for each new group of settings. */
const SECTIONS = [
  { id: "general", label: "General", Body: GeneralSettings },
  { id: "fonts", label: "Fonts", Body: FontSettings },
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

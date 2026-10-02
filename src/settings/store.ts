import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { create } from "zustand";

/** Shared with notify.ts: one JSON object, each writer merges its own keys. */
const SETTINGS_KEY = "herdr-app:settings";

export interface FontSettings {
  terminalFontSize: number;
  terminalFontFamily: string;
  chatFontSize: number;
}

export const DEFAULTS: FontSettings = {
  terminalFontSize: 13,
  terminalFontFamily: "JetBrains Mono",
  chatFontSize: 13.5,
};

export const TERM_SIZE = { min: 10, max: 20 };
export const CHAT_SIZE = { min: 11, max: 18 };

/** JetBrains Mono is bundled; the others only render if installed. */
export const TERM_FAMILIES = ["JetBrains Mono", "SF Mono", "Menlo", "Monaco", "Fira Code"];

const clamp = (n: number, r: { min: number; max: number }) => Math.min(r.max, Math.max(r.min, n));

function readRaw(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const p = raw ? (JSON.parse(raw) as unknown) : null;
    return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function normalize(p: Partial<Record<keyof FontSettings, unknown>>, base: FontSettings): FontSettings {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const family = typeof p.terminalFontFamily === "string" && p.terminalFontFamily.trim() ? p.terminalFontFamily.trim() : undefined;
  return {
    terminalFontSize: clamp(num(p.terminalFontSize) ?? base.terminalFontSize, TERM_SIZE),
    terminalFontFamily: family ?? base.terminalFontFamily,
    chatFontSize: clamp(num(p.chatFontSize) ?? base.chatFontSize, CHAT_SIZE),
  };
}

export function loadFonts(): FontSettings {
  return normalize(readRaw(), DEFAULTS);
}

function save(f: FontSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...readRaw(), ...f }));
  } catch {
    /* ignore */
  }
}

interface SettingsStore extends FontSettings {
  set: (patch: Partial<FontSettings>) => void;
  reset: () => void;
}

const pick = (s: FontSettings): FontSettings => ({
  terminalFontSize: s.terminalFontSize,
  terminalFontFamily: s.terminalFontFamily,
  chatFontSize: s.chatFontSize,
});

export const useSettings = create<SettingsStore>((setState, get) => ({
  ...loadFonts(),
  set: (patch) => {
    const next = normalize(patch, pick(get()));
    save(next);
    setState(next);
  },
  reset: () => {
    save(DEFAULTS);
    setState({ ...DEFAULTS });
  },
}));

export function termFontFamily(family: string): string {
  return `"${family}", Menlo, monospace`;
}

export function applyChatFont(px: number): void {
  document.documentElement.style.setProperty("--chat-font", `${px}px`);
}

/**
 * Applies the terminal font settings to `term` now and on every change, refitting so the
 * new cell size reaches the PTY through the terminal's own onResize. Returns an unsubscribe.
 * `offset` shifts the size (the blocked panel runs one px smaller).
 */
export function watchTermFont(term: Terminal, fit: FitAddon, offset = 0): () => void {
  const apply = (s: FontSettings) => {
    term.options.fontFamily = termFontFamily(s.terminalFontFamily);
    term.options.fontSize = s.terminalFontSize + offset;
  };
  apply(useSettings.getState());
  return useSettings.subscribe((s, prev) => {
    if (s.terminalFontSize === prev.terminalFontSize && s.terminalFontFamily === prev.terminalFontFamily) return;
    apply(s);
    try {
      fit.fit();
    } catch {
      /* not measurable (hidden) */
    }
  });
}

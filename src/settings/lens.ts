import { create } from "zustand";

/** Shared with store.ts, theme.ts, quickReplies.ts and notify.ts: one JSON object, each writer merges its own keys. */
const SETTINGS_KEY = "herdr-app:settings";

export interface LensSettings {
  /** Whether a pane showing the Terminal for want of a transcript turns to Chat once one exists. */
  chatAfterFirstPrompt: boolean;
}

function readRaw(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const p = raw ? (JSON.parse(raw) as unknown) : null;
    return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function save(patch: Record<string, unknown>): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...readRaw(), ...patch }));
  } catch {
    /* ignore */
  }
}

export function loadLensSettings(): LensSettings {
  const raw = readRaw();
  return { chatAfterFirstPrompt: typeof raw.chatAfterFirstPrompt === "boolean" ? raw.chatAfterFirstPrompt : true };
}

interface LensSettingsStore extends LensSettings {
  setChatAfterFirstPrompt: (on: boolean) => void;
}

export const useLensSettings = create<LensSettingsStore>((setState) => ({
  ...loadLensSettings(),
  setChatAfterFirstPrompt: (chatAfterFirstPrompt) => {
    save({ chatAfterFirstPrompt });
    setState({ chatAfterFirstPrompt });
  },
}));

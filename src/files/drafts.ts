import type { EditorState, Text } from "@codemirror/state";
import { create } from "zustand";
import type { FileContent, FileVersion } from "../lib/types";
import { fileItemKey } from "../store/openItems";
import { canEdit, createEditorState } from "./editorSetup";
import { relUnder } from "./store";

/** What a file looked like on disk when a Draft last matched it. */
export interface DiskVersion extends FileVersion {
  text: string;
}

export interface DraftTarget {
  fk: string;
  machineId: string;
  root: string;
  rel: string;
}

export interface Draft extends DraftTarget {
  /** Stable for the life of the Draft (survives rebase, save and rename); a new `open()` gets a new one. */
  id: number;
  state: EditorState;
  base: DiskVersion;
  /** `base.text` as a document; the Draft is dirty when `state.doc` differs from it. */
  baseDoc: Text;
  dirty: boolean;
  conflict: "changed" | "removed" | null;
  saving: boolean;
}

/** A Draft's key is its file Open item's key. */
export const draftKey = fileItemKey;

export function diskVersion(c: FileContent): DiskVersion | null {
  if (!canEdit(c) || c.text === null || c.cksum === null) return null;
  return { text: c.text, size: c.size, mtime: c.mtime, cksum: c.cksum };
}

interface DraftsState {
  drafts: Record<string, Draft>;
  /** (Re)creates a clean Draft. */
  open(target: DraftTarget, base: DiskVersion): void;
  update(key: string, state: EditorState): void;
  /** A clean Draft takes the new disk content; a dirty or saving one is left alone. */
  rebase(key: string, base: DiskVersion): void;
  saved(key: string, base: DiskVersion): void;
  setConflict(key: string, c: "changed" | "removed" | null): void;
  setSaving(key: string, on: boolean): void;
  moveUnder(fk: string, from: string, to: string): void;
  dropUnder(fk: string, rel: string): void;
  drop(key: string): void;
}

let nextId = 1;

export const useDrafts = create<DraftsState>()((set) => {
  const patch = (key: string, f: (d: Draft) => Partial<Draft>) =>
    set((s) => {
      const d = s.drafts[key];
      return d ? { drafts: { ...s.drafts, [key]: { ...d, ...f(d) } } } : s;
    });
  const without = (drafts: Record<string, Draft>, keep: (d: Draft) => boolean) =>
    Object.fromEntries(Object.entries(drafts).filter(([, d]) => keep(d)));

  return {
    drafts: {},
    open: (target, base) => {
      const state = createEditorState(base.text);
      const draft: Draft = { ...target, id: nextId++, state, base, baseDoc: state.doc, dirty: false, conflict: null, saving: false };
      set((s) => ({ drafts: { ...s.drafts, [draftKey(target.fk, target.rel)]: draft } }));
    },
    update: (key, state) => patch(key, (d) => ({ state, dirty: !state.doc.eq(d.baseDoc) })),
    rebase: (key, base) =>
      patch(key, (d) => {
        if (d.dirty || d.saving) return {};
        const state = createEditorState(base.text);
        return { state, base, baseDoc: state.doc };
      }),
    saved: (key, base) =>
      patch(key, (d) => {
        const baseDoc = d.state.toText(base.text);
        return { base, baseDoc, dirty: !d.state.doc.eq(baseDoc), conflict: null, saving: false };
      }),
    setConflict: (key, conflict) => patch(key, () => ({ conflict })),
    setSaving: (key, saving) => patch(key, () => ({ saving })),
    moveUnder: (fk, from, to) =>
      set((s) => {
        const drafts: Record<string, Draft> = {};
        for (const [key, d] of Object.entries(s.drafts)) {
          if (d.fk !== fk || !relUnder(d.rel, from)) {
            drafts[key] = d;
            continue;
          }
          const rel = to + d.rel.slice(from.length);
          drafts[draftKey(fk, rel)] = { ...d, rel };
        }
        return { drafts };
      }),
    dropUnder: (fk, rel) => set((s) => ({ drafts: without(s.drafts, (d) => d.fk !== fk || !relUnder(d.rel, rel)) })),
    drop: (key) => set((s) => (key in s.drafts ? { drafts: without(s.drafts, (d) => draftKey(d.fk, d.rel) !== key) } : s)),
  };
});

/** Keys of the dirty Drafts at or under `rel` in the files root `fk`. */
export const dirtyUnder = (fk: string, rel: string): string[] =>
  Object.entries(useDrafts.getState().drafts)
    .filter(([, d]) => d.fk === fk && d.dirty && relUnder(d.rel, rel))
    .map(([key]) => key);

export const isDirty = (key: string): boolean => useDrafts.getState().drafts[key]?.dirty ?? false;

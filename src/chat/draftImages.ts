import { create } from "zustand";

// Each pane's pasted-but-unsent images, kept outside the Composer (like drafts.ts keeps the
// text): it unmounts on a tab, pane or lens switch. Held in memory only, as Blobs' object URLs
// do not outlive the page.
export interface Attachment {
  id: number;
  preview: string;
  /** Path on the pane's Machine; null while the save is in flight. */
  path: string | null;
}

type Update = Attachment[] | ((cur: Attachment[]) => Attachment[]);

const NONE: Attachment[] = [];

export const useDraftImages = create<{
  byPane: Record<string, Attachment[]>;
  set: (paneKey: string, update: Update) => void;
}>((setState) => ({
  byPane: {},
  set: (paneKey, update) =>
    setState((s) => {
      const cur = s.byPane[paneKey] ?? NONE;
      const next = typeof update === "function" ? update(cur) : update;
      const byPane = { ...s.byPane };
      if (next.length > 0) byPane[paneKey] = next;
      else delete byPane[paneKey];
      return { byPane };
    }),
}));

/** `paneKey`'s attachments and a setter bound to that pane, safe to call after unmount. */
export function usePaneImages(paneKey: string): [Attachment[], (update: Update) => void] {
  const images = useDraftImages((s) => s.byPane[paneKey] ?? NONE);
  const set = useDraftImages((s) => s.set);
  return [images, (update) => set(paneKey, update)];
}

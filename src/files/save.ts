import { filesWrite } from "../lib/ipc";
import { showToast } from "../ui/Toast";
import { useDrafts, type Draft } from "./drafts";

/**
 * Writes a Draft over its base version (or over whatever is on disk when `force`).
 * Resolves true when written; false when nothing was written.
 */
export async function saveDraft(key: string, opts: { force: boolean }): Promise<boolean> {
  const { drafts, setSaving, setConflict, saved } = useDrafts.getState();
  const draft = drafts[key];
  if (!draft || draft.saving || (draft.conflict && !opts.force)) return false;
  const text = draft.state.sliceDoc();
  const { fk, id, machineId, root, rel, base } = draft;
  setSaving(key, true);
  // A rename during the save moves the Draft to a new key; it keeps its fk and id.
  // A Draft re-created by open() has a new id, so this save's result no longer applies.
  const current = (): [string, Draft] | null =>
    Object.entries(useDrafts.getState().drafts).find(([, d]) => d.fk === fk && d.id === id) ?? null;
  try {
    const version = await filesWrite(machineId, root, rel, text, opts.force ? null : { size: base.size, mtime: base.mtime, cksum: base.cksum });
    const found = current();
    if (found) saved(found[0], { text, ...version });
    return true;
  } catch (e) {
    const found = current();
    const { code, message } = (e ?? {}) as { code?: string; message?: string };
    if (found) {
      setSaving(found[0], false);
      if (code === "conflict") setConflict(found[0], "changed");
      else if (code === "not_found") setConflict(found[0], "removed");
    }
    if (code !== "conflict" && code !== "not_found") showToast(`Cannot save ${(found?.[1].rel ?? rel).split("/").pop()}: ${message ?? String(e)}`);
    return false;
  }
}

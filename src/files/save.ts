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
  const { fk, machineId, root, rel, base } = draft;
  setSaving(key, true);
  // A rename during the save moves the Draft to a new key; it keeps its fk and base object.
  const current = (): string | null => {
    const now = useDrafts.getState().drafts;
    if (now[key]?.base === base) return key;
    const moved = Object.entries(now).find(([, d]: [string, Draft]) => d.fk === fk && d.base === base);
    return moved ? moved[0] : null;
  };
  try {
    const version = await filesWrite(machineId, root, rel, text, opts.force ? null : { size: base.size, mtime: base.mtime, cksum: base.cksum });
    const k = current();
    if (k) saved(k, { text, ...version });
    return true;
  } catch (e) {
    const k = current();
    const { code, message } = (e ?? {}) as { code?: string; message?: string };
    if (k) {
      setSaving(k, false);
      if (code === "conflict") setConflict(k, "changed");
      else if (code === "not_found") setConflict(k, "removed");
    }
    if (code !== "conflict" && code !== "not_found") showToast(`Cannot save ${rel.split("/").pop()}: ${message ?? String(e)}`);
    return false;
  }
}

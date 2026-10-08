import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./save", () => ({ saveDraft: vi.fn(async () => true) }));
vi.mock("../ui/Toast", () => ({ showToast: vi.fn() }));
import { useApp } from "../store/app";
import { itemKey } from "../store/openItems";
import { closeItemsGuarded, settleDrafts } from "./closeGuard";
import { draftKey, useDrafts } from "./drafts";
import { saveDraft } from "./save";
import { filesKey } from "./store";
import { UnsavedDialog } from "./unsaved";
import { showToast } from "../ui/Toast";

const ws = { machine_id: "local", session: "default", workspace_id: "w1" };
const fk = filesKey(ws, "/r");
const openDraft = (rel: string, dirty: boolean) => {
  useDrafts.getState().open({ fk, machineId: "local", root: "/r", rel }, { text: "t", size: 1, mtime: 1, cksum: 1 });
  if (dirty) {
    const s = useDrafts.getState().drafts[draftKey(fk, rel)].state;
    useDrafts.getState().update(draftKey(fk, rel), s.update({ changes: { from: 0, insert: "!" } }).state);
  }
};

describe("settleDrafts", () => {
  beforeEach(() => {
    useDrafts.setState(useDrafts.getInitialState(), true);
    useApp.setState(useApp.getInitialState(), true);
    // Like the real one: nothing is written for a Draft already saving or in conflict.
    vi.mocked(saveDraft).mockReset().mockImplementation(async (k) => {
      const d = useDrafts.getState().drafts[k];
      return !!d && !d.saving && !d.conflict;
    });
    vi.mocked(showToast).mockClear();
    render(<UnsavedDialog />);
  });

  it("goes ahead without asking when nothing is dirty", async () => {
    openDraft("a.txt", false);
    expect(await settleDrafts([draftKey(fk, "a.txt")])).toBe(true);
    expect(useDrafts.getState().drafts).toEqual({});
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks once, and Cancel keeps everything", async () => {
    openDraft("a.txt", true);
    const p = settleDrafts([draftKey(fk, "a.txt")]);
    expect(await screen.findByText('Save changes to "a.txt"?')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await p).toBe(false);
    expect(useDrafts.getState().drafts[draftKey(fk, "a.txt")]).toBeTruthy();
  });

  it("Discard drops the drafts; Save All saves each dirty one first", async () => {
    openDraft("a.txt", true);
    openDraft("b.txt", true);
    openDraft("c.txt", false);
    const keys = ["a.txt", "b.txt", "c.txt"].map((r) => draftKey(fk, r));
    let p = settleDrafts(keys);
    expect(await screen.findByText("Save changes to 2 files?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save All" }));
    expect(await p).toBe(true);
    expect(vi.mocked(saveDraft).mock.calls.map((c) => c[0])).toEqual(keys.slice(0, 2));
    expect(useDrafts.getState().drafts).toEqual({});
    openDraft("a.txt", true);
    p = settleDrafts([keys[0]]);
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    expect(await p).toBe(true);
    expect(useDrafts.getState().drafts).toEqual({});
  });

  it("a failed save stops the close", async () => {
    openDraft("a.txt", true);
    vi.mocked(saveDraft).mockResolvedValueOnce(false);
    const p = settleDrafts([draftKey(fk, "a.txt")]);
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    expect(await p).toBe(false);
    expect(useDrafts.getState().drafts[draftKey(fk, "a.txt")]).toBeTruthy();
  });

  it("Save on a Draft in conflict says why, shows that file, and keeps everything", async () => {
    for (const [conflict, why] of [["changed", "it changed on disk"], ["removed", "it was deleted"]] as const) {
      vi.mocked(showToast).mockClear();
      useApp.getState().openFile(ws, "/r", "a.txt", { pin: true });
      useApp.getState().openFile(ws, "/r", "b.txt", { pin: true });
      openDraft("a.txt", true);
      openDraft("b.txt", true);
      useDrafts.getState().setConflict(draftKey(fk, "a.txt"), conflict);
      const p = settleDrafts([draftKey(fk, "b.txt"), draftKey(fk, "a.txt")]);
      fireEvent.click(await screen.findByRole("button", { name: "Save All" }));
      expect(await p).toBe(false);
      expect(vi.mocked(showToast).mock.calls).toEqual([[`Cannot save a.txt: ${why}`]]);
      expect(useApp.getState().openItems.active).toBe(draftKey(fk, "a.txt"));
      expect(useDrafts.getState().drafts[draftKey(fk, "a.txt")]).toBeTruthy();
    }
  });

  it("Save waits for a save already running, and is done if it left nothing unsaved", async () => {
    openDraft("a.txt", true);
    const k = draftKey(fk, "a.txt");
    useDrafts.getState().setSaving(k, true);
    let settled = false;
    const p = settleDrafts([k]).then((r) => ((settled = true), r));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
    expect(settled).toBe(false);
    act(() => useDrafts.getState().saved(k, { text: "!t", size: 2, mtime: 2, cksum: 2 }));
    expect(await p).toBe(true);
    expect(saveDraft).not.toHaveBeenCalled();
    expect(useDrafts.getState().drafts).toEqual({});
  });

  it("Save retries once when the save already running left the Draft unsaved", async () => {
    openDraft("a.txt", true);
    const k = draftKey(fk, "a.txt");
    useDrafts.getState().setSaving(k, true);
    const p = settleDrafts([k]);
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
    expect(saveDraft).not.toHaveBeenCalled();
    act(() => useDrafts.getState().setSaving(k, false));
    expect(await p).toBe(true);
    expect(vi.mocked(saveDraft).mock.calls).toEqual([[k, { force: false }]]);
  });

  it("closeItemsGuarded closes only after the drafts are settled", async () => {
    useApp.getState().openFile(ws, "/r", "a.txt", { pin: true });
    openDraft("a.txt", true);
    const key = itemKey({ kind: "file", ws, root: "/r", rel: "a.txt" });
    const p = closeItemsGuarded(key, "one");
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await act(() => p);
    expect(useApp.getState().openItems.items).toHaveLength(1);
    const q = closeItemsGuarded(key, "one");
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await act(() => q);
    expect(useApp.getState().openItems.items).toHaveLength(0);
  });
});

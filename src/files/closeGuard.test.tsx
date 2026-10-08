import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./save", () => ({ saveDraft: vi.fn(async () => true) }));
import { useApp } from "../store/app";
import { itemKey } from "../store/openItems";
import { closeItemsGuarded, settleDrafts } from "./closeGuard";
import { draftKey, useDrafts } from "./drafts";
import { saveDraft } from "./save";
import { filesKey } from "./store";
import { UnsavedDialog } from "./unsaved";

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
    vi.mocked(saveDraft).mockClear();
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

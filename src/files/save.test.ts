import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../ui/Toast", () => ({ showToast: vi.fn() }));
import { showToast } from "../ui/Toast";
import { draftKey, useDrafts } from "./drafts";
import { saveDraft } from "./save";

const fk = "fk";
const key = draftKey(fk, "src/a.txt");
const open = (text = "one\n") =>
  useDrafts.getState().open({ fk, machineId: "m1", root: "/r", rel: "src/a.txt" }, { text, size: text.length, mtime: 10, cksum: 99 });
const typeEnd = (s: string) => {
  const st = useDrafts.getState().drafts[key].state;
  useDrafts.getState().update(key, st.update({ changes: { from: st.doc.length, insert: s } }).state);
};

describe("saveDraft", () => {
  beforeEach(() => {
    useDrafts.setState(useDrafts.getInitialState(), true);
    vi.mocked(invoke).mockReset();
    vi.mocked(showToast).mockClear();
  });

  it("writes the text over the base version and takes the new version", async () => {
    open();
    typeEnd("two\n");
    vi.mocked(invoke).mockResolvedValueOnce({ size: 8, mtime: 11, cksum: 5 });
    expect(await saveDraft(key, { force: false })).toBe(true);
    expect(invoke).toHaveBeenCalledWith("files_write", {
      machineId: "m1", root: "/r", rel: "src/a.txt", text: "one\ntwo\n", expected: { size: 4, mtime: 10, cksum: 99 },
    });
    expect(useDrafts.getState().drafts[key]).toMatchObject({ dirty: false, saving: false, base: { text: "one\ntwo\n", cksum: 5 } });
  });

  it("forces with no expected version", async () => {
    open();
    vi.mocked(invoke).mockResolvedValueOnce({ size: 4, mtime: 12, cksum: 6 });
    await saveDraft(key, { force: true });
    expect(vi.mocked(invoke).mock.calls[0][1]).toMatchObject({ expected: null });
  });

  it("marks a conflict or a removal and keeps the edits", async () => {
    open();
    typeEnd("x");
    vi.mocked(invoke).mockRejectedValueOnce({ code: "conflict", message: "src/a.txt changed on disk" });
    expect(await saveDraft(key, { force: false })).toBe(false);
    expect(useDrafts.getState().drafts[key]).toMatchObject({ conflict: "changed", dirty: true, saving: false });
    expect(await saveDraft(key, { force: false })).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
    useDrafts.getState().setConflict(key, null);
    vi.mocked(invoke).mockRejectedValueOnce({ code: "not_found", message: "no such file" });
    await saveDraft(key, { force: false });
    expect(useDrafts.getState().drafts[key].conflict).toBe("removed");
  });

  it("reports other failures in a toast and does not save twice at once", async () => {
    open();
    let fail!: (e: unknown) => void;
    vi.mocked(invoke).mockReturnValueOnce(new Promise((_, rej) => (fail = rej)));
    const first = saveDraft(key, { force: false });
    expect(await saveDraft(key, { force: false })).toBe(false);
    fail({ code: "io", message: "disk full" });
    expect(await first).toBe(false);
    expect(showToast).toHaveBeenCalledWith("Cannot save a.txt: disk full");
    expect(useDrafts.getState().drafts[key]).toMatchObject({ saving: false, conflict: null });
  });

  it("records the save on the moved Draft when the file is renamed meanwhile", async () => {
    open();
    typeEnd("two\n");
    let done!: (v: unknown) => void;
    vi.mocked(invoke).mockReturnValueOnce(new Promise((res) => (done = res)));
    const p = saveDraft(key, { force: false });
    useDrafts.getState().moveUnder(fk, "src/a.txt", "src/b.txt");
    done({ size: 8, mtime: 11, cksum: 5 });
    expect(await p).toBe(true);
    expect(useDrafts.getState().drafts[draftKey(fk, "src/b.txt")]).toMatchObject({ dirty: false, saving: false, base: { cksum: 5 } });
  });

  it("does nothing when the Draft was dropped during the save", async () => {
    open();
    let done!: (v: unknown) => void;
    vi.mocked(invoke).mockReturnValueOnce(new Promise((res) => (done = res)));
    const p = saveDraft(key, { force: false });
    useDrafts.getState().drop(key);
    done({ size: 4, mtime: 11, cksum: 5 });
    expect(await p).toBe(true);
    expect(useDrafts.getState().drafts).toEqual({});
  });

  it("keeps the Draft usable when a read rebases it during the save", async () => {
    open();
    let done!: (v: unknown) => void;
    vi.mocked(invoke).mockReturnValueOnce(new Promise((res) => (done = res)));
    const p = saveDraft(key, { force: true });
    useDrafts.getState().rebase(key, { text: "other\n", size: 6, mtime: 20, cksum: 1 });
    done({ size: 4, mtime: 11, cksum: 5 });
    expect(await p).toBe(true);
    expect(useDrafts.getState().drafts[key]).toMatchObject({ saving: false, base: { text: "one\n", cksum: 5 } });
  });

  it("ignores the result for a Draft re-opened during the save", async () => {
    open();
    let done!: (v: unknown) => void;
    vi.mocked(invoke).mockReturnValueOnce(new Promise((res) => (done = res)));
    const p = saveDraft(key, { force: true });
    open("fresh\n");
    done({ size: 4, mtime: 11, cksum: 5 });
    await p;
    expect(useDrafts.getState().drafts[key]).toMatchObject({ saving: false, base: { text: "fresh\n", cksum: 99 } });
  });
});

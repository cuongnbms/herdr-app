import { undo } from "@codemirror/commands";
import type { EditorState, Transaction } from "@codemirror/state";
import { beforeEach, describe, expect, it } from "vitest";
import { itemKey } from "../store/openItems";
import { dirtyUnder, draftKey, isDirty, useDrafts, type DiskVersion } from "./drafts";
import { filesKey } from "./store";

const ws = { machine_id: "local", session: "default", workspace_id: "w1" };
const fk = filesKey(ws, "/r");
const target = (rel: string) => ({ fk, machineId: "local", root: "/r", rel });
const base = (text: string, cksum = 1): DiskVersion => ({ text, size: text.length, mtime: 1, cksum });
const d = (rel: string) => useDrafts.getState().drafts[draftKey(fk, rel)];
const type = (rel: string, insert: string) => {
  const s = d(rel).state;
  useDrafts.getState().update(draftKey(fk, rel), s.update({ changes: { from: s.doc.length, insert } }).state);
};
const undoOnce = (rel: string) => {
  let next: EditorState = d(rel).state;
  undo({ state: next, dispatch: (tr: Transaction) => void (next = tr.state) });
  useDrafts.getState().update(draftKey(fk, rel), next);
};

describe("drafts", () => {
  beforeEach(() => useDrafts.setState(useDrafts.getInitialState(), true));

  it("keys a draft like its Open item", () => {
    expect(draftKey(fk, "src/a.ts")).toBe(itemKey({ kind: "file", ws, root: "/r", rel: "src/a.ts" }));
  });

  it("is dirty after typing and clean again after undoing back to the base", () => {
    useDrafts.getState().open(target("a.txt"), base("one\n"));
    expect(d("a.txt").dirty).toBe(false);
    type("a.txt", "two");
    expect(isDirty(draftKey(fk, "a.txt"))).toBe(true);
    undoOnce("a.txt");
    expect(d("a.txt").dirty).toBe(false);
  });

  it("rebases a clean draft onto newer disk content but never a dirty one", () => {
    useDrafts.getState().open(target("a.txt"), base("one\n"));
    useDrafts.getState().rebase(draftKey(fk, "a.txt"), base("agent\n", 2));
    expect(d("a.txt").state.sliceDoc()).toBe("agent\n");
    expect(d("a.txt").base.cksum).toBe(2);
    type("a.txt", "mine");
    useDrafts.getState().rebase(draftKey(fk, "a.txt"), base("agent again\n", 3));
    expect(d("a.txt").state.sliceDoc()).toBe("agent\nmine");
    expect(d("a.txt").base.cksum).toBe(2);
  });

  it("after a save stays dirty only for text typed since", () => {
    useDrafts.getState().open(target("a.txt"), base("one\n"));
    type("a.txt", "x");
    useDrafts.getState().setSaving(draftKey(fk, "a.txt"), true);
    useDrafts.getState().saved(draftKey(fk, "a.txt"), base("one\nx", 5));
    expect(d("a.txt")).toMatchObject({ dirty: false, saving: false, conflict: null });
    type("a.txt", "y");
    useDrafts.getState().saved(draftKey(fk, "a.txt"), base("one\nxy", 6));
    type("a.txt", "z");
    expect(d("a.txt").dirty).toBe(true);
    useDrafts.getState().saved(draftKey(fk, "a.txt"), base("one\nxy", 6));
    expect(d("a.txt").dirty).toBe(true);
  });

  it("follows a folder rename and drops everything under a deleted path", () => {
    useDrafts.getState().open(target("src/a.txt"), base("a"));
    useDrafts.getState().open(target("src/sub/b.txt"), base("b"));
    useDrafts.getState().open(target("srcx.txt"), base("c"));
    type("src/sub/b.txt", "!");
    useDrafts.getState().moveUnder(fk, "src", "lib");
    expect(Object.keys(useDrafts.getState().drafts).sort()).toEqual(
      [draftKey(fk, "lib/a.txt"), draftKey(fk, "lib/sub/b.txt"), draftKey(fk, "srcx.txt")].sort(),
    );
    expect(d("lib/sub/b.txt")).toMatchObject({ rel: "lib/sub/b.txt", dirty: true });
    expect(dirtyUnder(fk, "lib")).toEqual([draftKey(fk, "lib/sub/b.txt")]);
    useDrafts.getState().dropUnder(fk, "lib");
    expect(Object.keys(useDrafts.getState().drafts)).toEqual([draftKey(fk, "srcx.txt")]);
  });

  it("touch refreshes the base mtime and clears a conflict without replacing the state", () => {
    const k = draftKey(fk, "a.txt");
    useDrafts.getState().open(target("a.txt"), base("one\n"));
    type("a.txt", "mine");
    useDrafts.getState().setConflict(k, "removed");
    const before = d("a.txt").state;
    useDrafts.getState().touch(k, 9);
    expect(d("a.txt").state).toBe(before);
    expect(d("a.txt")).toMatchObject({ dirty: true, conflict: null, base: { mtime: 9, cksum: 1, text: "one\n" } });
  });

  it("counts the saves that landed", () => {
    const k = draftKey(fk, "a.txt");
    useDrafts.getState().open(target("a.txt"), base("one\n"));
    useDrafts.getState().saved(k, base("one\n", 2));
    expect(d("a.txt").gen).toBe(1);
  });
});

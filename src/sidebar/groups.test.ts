import { describe, expect, it } from "vitest";
import {
  EMPTY_LAYOUT, addGroup, canMove, deleteGroup, forgetMachine, forgetSessions, groupPaths, moveBookmark, moveNode,
  renameGroup, sessionKey, setBookmarked,
} from "./groups";
import type { GroupNode, Layout, LayoutNode, SessionNode } from "./groups";

const s = (key: string): SessionNode => ({ kind: "session", key });
const g = (id: string, ...children: LayoutNode[]): GroupNode => ({ kind: "group", id, label: id.toUpperCase(), children });
const L = (...tree: LayoutNode[]): Layout => ({ tree, bookmarks: [] });
const shape = (nodes: LayoutNode[]): unknown[] => nodes.map((n) => (n.kind === "group" ? { [n.id]: shape(n.children) } : n.key));
const S = (key: string) => ({ kind: "session" as const, key });
const G = (id: string) => ({ kind: "group" as const, id });

describe("sessionKey", () => {
  it("encodes both parts", () => {
    expect(sessionKey("local", "default")).toBe("local/default");
    expect(sessionKey("a/b", "x y")).toBe("a%2Fb/x%20y");
  });
});

describe("moveNode", () => {
  it("appends into a group and into the root", () => {
    const l = L(g("a", s("x")), s("y"));
    expect(shape(moveNode(l, S("y"), { kind: "into", groupId: "a" }).tree)).toEqual([{ a: ["x", "y"] }]);
    expect(shape(moveNode(l, S("x"), { kind: "into", groupId: null }).tree)).toEqual([{ a: [] }, "y", "x"]);
  });
  it("inserts as first child with first", () => {
    const l = L(g("a", s("x")), s("y"));
    expect(shape(moveNode(l, S("y"), { kind: "into", groupId: "a", first: true }).tree)).toEqual([{ a: ["y", "x"] }]);
  });
  it("moves before and after a row in another parent", () => {
    const l = L(g("a", s("x")), s("y"));
    expect(shape(moveNode(l, S("y"), { kind: "before", ref: S("x") }).tree)).toEqual([{ a: ["y", "x"] }]);
    expect(shape(moveNode(l, S("y"), { kind: "after", ref: S("x") }).tree)).toEqual([{ a: ["x", "y"] }]);
  });
  it("accounts for the index shift inside the same parent", () => {
    const l = L(s("x"), s("y"), s("z"));
    expect(shape(moveNode(l, S("x"), { kind: "after", ref: S("y") }).tree)).toEqual(["y", "x", "z"]);
    expect(shape(moveNode(l, S("z"), { kind: "before", ref: S("x") }).tree)).toEqual(["z", "x", "y"]);
    expect(shape(moveNode(l, S("x"), { kind: "after", ref: S("z") }).tree)).toEqual(["y", "z", "x"]);
  });
  it("moves a group with its children", () => {
    const l = L(g("a", s("x")), g("b"));
    expect(shape(moveNode(l, G("a"), { kind: "into", groupId: "b" }).tree)).toEqual([{ b: [{ a: ["x"] }] }]);
  });
  it("refuses a group into itself or its descendant, and a node onto itself", () => {
    const l = L(g("a", g("b", s("x"))));
    expect(moveNode(l, G("a"), { kind: "into", groupId: "b" })).toBe(l);
    expect(moveNode(l, G("a"), { kind: "before", ref: S("x") })).toBe(l);
    expect(moveNode(l, G("a"), { kind: "into", groupId: "a" })).toBe(l);
    expect(moveNode(l, S("x"), { kind: "before", ref: S("x") })).toBe(l);
    expect(canMove(l, G("a"), { kind: "into", groupId: "b" })).toBe(false);
    expect(canMove(l, S("x"), { kind: "into", groupId: null })).toBe(true);
  });
  it("is a no-op for an unknown target", () => {
    const l = L(s("x"));
    expect(moveNode(l, S("x"), { kind: "into", groupId: "nope" })).toBe(l);
  });
  it("places unplaced sessions at the end of the root first", () => {
    expect(shape(moveNode(L(g("a")), S("n"), { kind: "into", groupId: "a" }, ["m", "n"]).tree)).toEqual([{ a: ["n"] }, "m"]);
    expect(shape(moveNode(EMPTY_LAYOUT, S("n"), { kind: "before", ref: S("m") }, ["m", "n"]).tree)).toEqual(["n", "m"]);
  });
  it("does not mutate its input", () => {
    const l = L(g("a", s("x")), s("y"));
    const copy = structuredClone(l);
    moveNode(l, S("y"), { kind: "into", groupId: "a" });
    expect(l).toEqual(copy);
  });
});

describe("groups", () => {
  it("adds trimmed groups at the root and nested, and rejects empty labels", () => {
    const r = addGroup(L(g("a")), null, "  Work ");
    expect(r.id).toEqual(expect.any(String));
    expect(r.layout.tree[1]).toEqual({ kind: "group", id: r.id, label: "Work", children: [] });
    const n = addGroup(L(g("a")), "a", "Sub");
    expect((n.layout.tree[0] as GroupNode).children[0]).toMatchObject({ kind: "group", label: "Sub" });
    const l = L(g("a"));
    expect(addGroup(l, null, "   ")).toEqual({ layout: l, id: null });
  });
  it("renames, keeping the old label for an empty one", () => {
    expect((renameGroup(L(g("a")), "a", " New ").tree[0] as GroupNode).label).toBe("New");
    const l = L(g("a"));
    expect(renameGroup(l, "a", " ")).toBe(l);
  });
  it("deletes a group, promoting its children in place", () => {
    const l = L(s("p"), g("a", s("x"), g("b", s("y"))), s("q"));
    expect(shape(deleteGroup(l, "a").tree)).toEqual(["p", "x", { b: ["y"] }, "q"]);
  });
  it("lists group paths depth-first", () => {
    expect(groupPaths(L(g("a", g("b")), g("c")))).toEqual([
      { id: "a", path: "A" }, { id: "b", path: "A › B" }, { id: "c", path: "C" },
    ]);
  });
});

describe("bookmarks and forgetting", () => {
  it("bookmarks once, unbookmarks, and reorders", () => {
    let l = setBookmarked(EMPTY_LAYOUT, "x", true);
    l = setBookmarked(l, "x", true);
    l = setBookmarked(l, "y", true);
    expect(l.bookmarks).toEqual(["x", "y"]);
    expect(moveBookmark(l, "y", "x").bookmarks).toEqual(["y", "x"]);
    expect(moveBookmark(l, "x", null).bookmarks).toEqual(["y", "x"]);
    expect(setBookmarked(l, "x", false).bookmarks).toEqual(["y"]);
  });
  it("forgets sessions in the tree and in bookmarks", () => {
    const l = { tree: [g("a", s("x"), s("y"))], bookmarks: ["x", "z"] };
    const r = forgetSessions(l, ["x", "z"]);
    expect(shape(r.tree)).toEqual([{ a: ["y"] }]);
    expect(r.bookmarks).toEqual([]);
  });
  it("forgets every session of a machine", () => {
    const k1 = sessionKey("box", "a"), k2 = sessionKey("boxy", "b");
    const r = forgetMachine({ tree: [s(k1), s(k2)], bookmarks: [k1] }, "box");
    expect(shape(r.tree)).toEqual([k2]);
    expect(r.bookmarks).toEqual([]);
  });
});

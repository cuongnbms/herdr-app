import { describe, expect, it } from "vitest";
import type { MachineView, PaneRef } from "../lib/types";
import { closeItems, cycleItem, dropItems, itemKey, moveItem, NO_ITEMS, openItem, pinItem, pruneItems, setActive, type OpenItem, type OpenItems } from "./openItems";

const ws = (workspace_id = "w1", session = "s", machine_id = "local") => ({ machine_id, session, workspace_id });
const a = (pane_id: string, session = "s", machine_id = "local"): OpenItem => ({ kind: "agent", ref: { machine_id, session, pane_id } as PaneRef });
const f = (rel: string, w = ws(), root = "/r"): OpenItem => ({ kind: "file", ws: w, root, rel });
const k = itemKey;
const pin = { pin: true };
const peek = { pin: false };
const of = (items: OpenItem[], preview: OpenItem | null = null, active: OpenItem | null = null): OpenItems => ({
  items, preview: preview && k(preview), active: active && k(active),
});

describe("open items", () => {
  it("keys agents by pane and files by workspace, root and path", () => {
    expect(k(a("p1"))).toBe("agent:local/s/p1");
    expect(k(f("src/a.ts"))).toBe("file:local/s/w1|/r|src/a.ts");
  });

  it("an unpinned open of either kind replaces the preview in place and becomes active", () => {
    let s = openItem(of([a("p1")]), f("x.md"), peek);
    expect(s).toEqual(of([a("p1"), f("x.md")], f("x.md"), f("x.md")));
    s = openItem(s, a("p2"), peek);
    expect(s).toEqual(of([a("p1"), a("p2")], a("p2"), a("p2")));
  });

  it("a pinned open promotes the preview; opening an open item only activates it", () => {
    const s = openItem(of([a("p1")]), f("x.md"), peek);
    expect(openItem(s, a("p2"), pin)).toEqual(of([a("p1"), f("x.md"), a("p2")], null, a("p2")));
    expect(openItem(s, a("p1"), peek)).toEqual(of([a("p1"), f("x.md")], f("x.md"), a("p1")));
    expect(openItem(s, f("x.md"), pin)).toEqual(of([a("p1"), f("x.md")], null, f("x.md")));
    expect(pinItem(s, k(f("x.md")))).toEqual(of([a("p1"), f("x.md")], null, f("x.md")));
    expect(pinItem(s, k(a("p1")))).toBe(s);
  });

  it("closes one, others, to the right, or all, handing the active item over", () => {
    const s = of([a("p1"), f("b"), a("p3"), f("d")], f("d"), f("b"));
    expect(closeItems(s, "one", k(f("b")))).toEqual(of([a("p1"), a("p3"), f("d")], f("d"), a("p3")));
    expect(closeItems(of([a("p1"), f("b")], null, f("b")), "one", k(f("b")))).toEqual(of([a("p1")], null, a("p1")));
    expect(closeItems(s, "others", k(a("p3")))).toEqual(of([a("p3")], null, a("p3")));
    expect(closeItems(s, "right", k(f("b")))).toEqual(of([a("p1"), f("b")], null, f("b")));
    expect(closeItems(s, "all", k(f("b")))).toEqual(NO_ITEMS);
    expect(closeItems(s, "one", k(a("nope")))).toBe(s);
  });

  it("cycles the active item with wrap-around", () => {
    const s = of([a("p1"), f("b"), a("p3")], null, a("p3"));
    expect(cycleItem(s, 1).active).toBe(k(a("p1")));
    expect(cycleItem(s, -1).active).toBe(k(f("b")));
    expect(cycleItem(of([a("p1"), f("b")]), 1).active).toBe(k(a("p1")));
    expect(cycleItem(NO_ITEMS, 1)).toBe(NO_ITEMS);
  });

  it("moves an item before or after another, keeping preview and active", () => {
    const s = of([a("p1"), f("b"), a("p3")], f("b"), a("p3"));
    expect(moveItem(s, k(a("p3")), k(a("p1")), "before")).toEqual(of([a("p3"), a("p1"), f("b")], f("b"), a("p3")));
    expect(moveItem(s, k(a("p1")), k(a("p3")), "after")).toEqual(of([f("b"), a("p3"), a("p1")], f("b"), a("p3")));
    expect(moveItem(s, k(a("p1")), k(a("p3")), "before")).toEqual(of([f("b"), a("p1"), a("p3")], f("b"), a("p3")));
    expect(moveItem(s, k(a("p1")), k(f("b")), "before")).toBe(s);
    expect(moveItem(s, k(a("p1")), k(a("p1")), "after")).toBe(s);
    expect(moveItem(s, k(a("nope")), k(a("p1")), "after")).toBe(s);
    expect(moveItem(s, k(a("p1")), k(a("nope")), "after")).toBe(s);
  });

  it("setActive ignores unknown keys", () => {
    const s = of([a("p1")]);
    expect(setActive(s, k(a("p1"))).active).toBe(k(a("p1")));
    expect(setActive(s, "agent:nope")).toBe(s);
    expect(setActive(s, null).active).toBeNull();
  });

  it("prunes gone panes and gone workspaces of that machine only", () => {
    const v = { id: "local", sessions: [{ name: "s", workspaces: [{ workspace_id: "w1", tabs: [{ panes: [{ pane_id: "p1" }] }] }] }] } as unknown as MachineView;
    const s = of([a("p1"), a("p2"), f("x", ws("w1")), f("y", ws("w2")), a("p9", "s", "devtuf"), f("z", ws("w2", "s", "devtuf"))], null, f("y", ws("w2")));
    expect(pruneItems(s, v)).toEqual(of([a("p1"), f("x", ws("w1")), a("p9", "s", "devtuf"), f("z", ws("w2", "s", "devtuf"))]));
  });

  it("dropItems keeps the same object when nothing matches", () => {
    const s = of([a("p1"), f("x")]);
    expect(dropItems(s, () => false)).toBe(s);
    expect(dropItems(s, (i) => i.kind === "file")).toEqual(of([a("p1")]));
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_LAYOUT, LAYOUT_KEY, loadLayout, resolve, saveLayout, sessionKey, useLayout } from "./groups";
import type { RNode } from "./groups";
import type { MachineView, SessionView } from "../lib/types";

const sess = (name: string): SessionView => ({ name, running: true, status: "idle", error: null, workspaces: [] });
const mach = (id: string, ...names: string[]): MachineView => ({
  id, label: id, kind: "ssh", state: "connected", error: null, version: "0.9.3", status: "idle", sessions: names.map(sess),
});
const names = (nodes: RNode[]): unknown[] => nodes.map((n) => (n.kind === "group" ? { [n.label]: names(n.children) } : `${n.machine.id}:${n.session.name}`));

describe("layout storage", () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
  it("round-trips", () => {
    const l = { tree: [{ kind: "session" as const, key: "local/x" }], bookmarks: ["local/x"] };
    saveLayout(l);
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!)).toEqual(l);
    expect(loadLayout()).toEqual(l);
  });
  it("reads missing, corrupt or misshapen values as empty", () => {
    expect(loadLayout()).toEqual(EMPTY_LAYOUT);
    localStorage.setItem(LAYOUT_KEY, "{nope");
    expect(loadLayout()).toEqual(EMPTY_LAYOUT);
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ tree: 3 }));
    expect(loadLayout()).toEqual(EMPTY_LAYOUT);
  });
  it("reads as empty when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    expect(loadLayout()).toEqual(EMPTY_LAYOUT);
  });
  it("update saves the new layout", () => {
    useLayout.setState({ layout: EMPTY_LAYOUT });
    useLayout.getState().update((l) => ({ ...l, bookmarks: ["local/x"] }));
    expect(useLayout.getState().layout.bookmarks).toEqual(["local/x"]);
    expect(loadLayout().bookmarks).toEqual(["local/x"]);
  });
});

describe("resolve", () => {
  const machines = { local: mach("local", "a", "b"), box: mach("box", "c") };
  it("joins placed sessions, hides missing ones and appends unplaced ones in machine order", () => {
    const layout = {
      tree: [
        { kind: "group" as const, id: "g1", label: "Work", children: [{ kind: "session" as const, key: sessionKey("local", "b") }] },
        { kind: "session" as const, key: sessionKey("ghost", "zz") },
        { kind: "session" as const, key: sessionKey("local", "gone") },
      ],
      bookmarks: [sessionKey("local", "a"), sessionKey("ghost", "zz")],
    };
    const r = resolve(layout, machines, ["local", "box"]);
    expect(names(r.tree)).toEqual([{ Work: ["local:b"] }, "local:a", "box:c"]);
    expect(r.bookmarks.map((b) => b.session.name)).toEqual(["a"]);
    expect(r.unplaced).toEqual([sessionKey("local", "a"), sessionKey("box", "c")]);
  });
  it("shows every session at the root for an empty layout", () => {
    expect(names(resolve(EMPTY_LAYOUT, machines, ["box", "local"]).tree)).toEqual(["box:c", "local:a", "local:b"]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_LAYOUT, LAYOUT_KEY, initLayout, loadLayout, resolve, sessionKey, useLayout } from "./groups";
import type { RNode } from "./groups";
import type { MachineView, SessionView } from "../lib/types";

const sess = (name: string): SessionView => ({ name, running: true, status: "idle", error: null, workspaces: [] });
const mach = (id: string, ...names: string[]): MachineView => ({
  id, label: id, kind: "ssh", state: "connected", error: null, version: "0.9.3", status: "idle", sessions: names.map(sess),
});
const names = (nodes: RNode[]): unknown[] => nodes.map((n) => (n.kind === "group" ? { [n.label]: names(n.children) } : `${n.machine.id}:${n.session.name}`));

describe("legacy localStorage layout", () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
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
});

describe("layout file", () => {
  const l = { tree: [{ kind: "session" as const, key: "local/x" }], bookmarks: ["local/x"] };
  const io = (stored: unknown) => ({ load: vi.fn().mockResolvedValue(stored), save: vi.fn().mockResolvedValue(undefined) });
  const flush = () => new Promise((r) => setTimeout(r));
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); useLayout.setState({ layout: EMPTY_LAYOUT }); });

  it("loads the saved file and does not rewrite it", async () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ tree: [], bookmarks: ["old/y"] }));
    const f = io(l);
    await initLayout(f);
    expect(useLayout.getState().layout).toEqual(l);
    expect(f.save).not.toHaveBeenCalled();
    expect(localStorage.getItem(LAYOUT_KEY)).toBeNull();
  });
  it("migrates the localStorage layout into a missing file, then drops the old key", async () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(l));
    const f = io(null);
    await initLayout(f);
    await flush();
    expect(useLayout.getState().layout).toEqual(l);
    expect(f.save).toHaveBeenCalledWith(l);
    expect(localStorage.getItem(LAYOUT_KEY)).toBeNull();
  });
  it("keeps the old key when the migration write fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(l));
    const f = io(null);
    f.save.mockRejectedValueOnce(new Error("disk full"));
    await initLayout(f);
    await flush();
    expect(localStorage.getItem(LAYOUT_KEY)).not.toBeNull();
  });
  it("migrates over a misshapen file", async () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(l));
    const f = io({ tree: 3 });
    await initLayout(f);
    await flush();
    expect(f.save).toHaveBeenCalledWith(l);
  });
  it("writes nothing when neither the file nor localStorage has a layout", async () => {
    const f = io(null);
    await initLayout(f);
    await flush();
    expect(useLayout.getState().layout).toEqual(EMPTY_LAYOUT);
    expect(f.save).not.toHaveBeenCalled();
  });
  it("saves every update in order", async () => {
    const f = io(null);
    await initLayout(f);
    useLayout.getState().update((x) => ({ ...x, bookmarks: ["a"] }));
    useLayout.getState().update((x) => ({ ...x, bookmarks: ["a", "b"] }));
    await flush();
    expect(f.save.mock.calls.map((c) => c[0].bookmarks)).toEqual([["a"], ["a", "b"]]);
    expect(localStorage.getItem(LAYOUT_KEY)).toBeNull();
  });
  it("keeps saving after a failed write", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = io(null);
    f.save.mockRejectedValueOnce(new Error("disk full"));
    await initLayout(f);
    useLayout.getState().update((x) => ({ ...x, bookmarks: ["a"] }));
    useLayout.getState().update((x) => ({ ...x, bookmarks: ["b"] }));
    await flush();
    expect(f.save).toHaveBeenCalledTimes(2);
  });
  it("falls back to localStorage without writing when the file cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(l));
    const f = { load: vi.fn().mockRejectedValue(new Error("ipc")), save: vi.fn() };
    await initLayout(f);
    expect(useLayout.getState().layout).toEqual(l);
    useLayout.getState().update((x) => ({ ...x, bookmarks: [] }));
    await flush();
    expect(f.save).not.toHaveBeenCalled();
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

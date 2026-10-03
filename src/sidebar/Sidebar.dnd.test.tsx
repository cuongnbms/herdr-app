import { act, createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ sessionStart: vi.fn().mockResolvedValue(undefined) }));
import { useApp } from "../store/app";
import { sessionKey, useLayout } from "./groups";
import type { GroupNode } from "./groups";
import { Sidebar } from "./Sidebar";
import type { MachineView } from "../lib/types";

const sess = (name: string) => ({ name, running: true, status: "idle" as const, error: null, workspaces: [] });
const local: MachineView = { id: "local", label: "local", kind: "local", state: "connected", error: null, version: "0.9.3", status: "idle", sessions: [sess("x"), sess("y")] };
const kx = sessionKey("local", "x"), ky = sessionKey("local", "y");
const dt = () => {
  const data: Record<string, string> = {};
  return { data, types: [] as string[], effectAllowed: "", dropEffect: "",
    setData(t: string, v: string) { data[t] = v; this.types.push(t); }, getData: (t: string) => data[t] ?? "", setDragImage() {} };
};
const rowOf = (text: string) => screen.getAllByText(text)[0].closest("button")!;
const drag = (from: HTMLElement, to: HTMLElement) => {
  const dataTransfer = dt();
  fireEvent.dragStart(from, { dataTransfer });
  fireEvent.dragEnter(to, { dataTransfer });
  fireEvent.dragOver(to, { dataTransfer });
  fireEvent.drop(to, { dataTransfer });
  fireEvent.dragEnd(from, { dataTransfer });
};

describe("Sidebar drag and drop", () => {
  beforeEach(() => {
    useApp.setState({ machines: { local }, order: ["local"], selected: null, viewed: null, expanded: {} });
    useLayout.setState({ layout: { tree: [{ kind: "group", id: "a", label: "A", children: [] }], bookmarks: [] } });
  });
  afterEach(() => vi.useRealTimers());

  it("drops an unplaced session into a group", () => {
    render(<Sidebar />);
    drag(rowOf("y"), rowOf("A"));
    const tree = useLayout.getState().layout.tree;
    expect((tree[0] as GroupNode).children).toEqual([{ kind: "session", key: ky }]);
    expect(tree[1]).toEqual({ kind: "session", key: kx });
    expect(document.querySelector(".drop-into, .drop-before, .drop-after")).toBeNull();
    // The dragged row was remounted under the group, so its dragend never reached React.
    expect(screen.queryByRole("region", { name: "Bookmarks" })).toBeNull();
  });
  it("does not bookmark a session dropped on a bookmark row", () => {
    useLayout.setState({ layout: { tree: [], bookmarks: [ky] } });
    render(<Sidebar />);
    const bm = screen.getByRole("region", { name: "Bookmarks" });
    const before = useLayout.getState().layout;
    drag(rowOf("x"), within(bm).getByText("y").closest("button")!);
    expect(useLayout.getState().layout).toBe(before);
  });
  it("shows an into indicator and inserts first when dropping below an open group with children", () => {
    useLayout.setState({ layout: { tree: [{ kind: "group", id: "a", label: "A", children: [{ kind: "session", key: ky }] }], bookmarks: [] } });
    render(<Sidebar />);
    const dataTransfer = dt();
    const g = rowOf("A");
    g.getBoundingClientRect = () => ({ top: 0, height: 100, bottom: 100, left: 0, right: 100, width: 100, x: 0, y: 0, toJSON() {} });
    fireEvent.dragStart(rowOf("x"), { dataTransfer });
    // jsdom has no DragEvent, so clientY must be set by hand.
    const over = createEvent.dragOver(g, { dataTransfer });
    Object.defineProperty(over, "clientY", { value: 90 });
    fireEvent(g, over);
    expect(g.className).toContain("drop-into");
    const drop = createEvent.drop(g, { dataTransfer });
    Object.defineProperty(drop, "clientY", { value: 90 });
    fireEvent(g, drop);
    const tree = useLayout.getState().layout.tree;
    expect((tree[0] as GroupNode).children).toEqual([{ kind: "session", key: kx }, { kind: "session", key: ky }]);
  });
  it("refuses to drop a group into its own child", () => {
    useLayout.setState({ layout: { tree: [{ kind: "group", id: "a", label: "A", children: [{ kind: "group", id: "b", label: "B", children: [] }] }], bookmarks: [] } });
    const before = useLayout.getState().layout;
    render(<Sidebar />);
    const dataTransfer = dt();
    fireEvent.dragStart(rowOf("A"), { dataTransfer });
    fireEvent.dragEnter(rowOf("B"), { dataTransfer });
    fireEvent.dragOver(rowOf("B"), { dataTransfer });
    expect(document.querySelector(".drop-into, .drop-before, .drop-after")).toBeNull();
    fireEvent.drop(rowOf("B"), { dataTransfer });
    fireEvent.dragEnd(rowOf("A"), { dataTransfer });
    expect(useLayout.getState().layout).toBe(before);
  });
  it("shows no indicator for a session dragged over its own row", () => {
    useLayout.setState({ layout: { tree: [{ kind: "session", key: kx }, { kind: "session", key: ky }], bookmarks: [] } });
    render(<Sidebar />);
    const dataTransfer = dt();
    fireEvent.dragStart(rowOf("x"), { dataTransfer });
    fireEvent.dragOver(rowOf("x"), { dataTransfer });
    expect(document.querySelector(".drop-into, .drop-before, .drop-after")).toBeNull();
    expect(dataTransfer.dropEffect).toBe("none");
    fireEvent.dragEnd(rowOf("x"), { dataTransfer });
  });
  it("clears the Bookmarks highlight when a session drag moves onto a bookmark row", () => {
    useLayout.setState({ layout: { tree: [], bookmarks: [ky] } });
    render(<Sidebar />);
    const bm = screen.getByRole("region", { name: "Bookmarks" });
    const dataTransfer = dt();
    fireEvent.dragStart(rowOf("x"), { dataTransfer });
    fireEvent.dragOver(within(bm).getByText("Bookmarks"), { dataTransfer });
    expect(document.querySelector(".drop-into")).not.toBeNull();
    fireEvent.dragOver(within(bm).getByText("y").closest("button")!, { dataTransfer });
    expect(document.querySelector(".drop-into, .drop-before, .drop-after")).toBeNull();
    fireEvent.dragEnd(rowOf("x"), { dataTransfer });
  });
  it("waits until after dragstart to show empty Bookmarks", () => {
    vi.useFakeTimers();
    render(<Sidebar />);
    const dataTransfer = dt();
    fireEvent.dragStart(rowOf("x"), { dataTransfer });
    // Inserting the section during dragstart shifts the rows under the pointer and WebKit cancels the drag.
    expect(screen.queryByRole("region", { name: "Bookmarks" })).toBeNull();
    act(() => vi.runOnlyPendingTimers());
    expect(screen.queryByRole("region", { name: "Bookmarks" })).not.toBeNull();
    fireEvent.dragEnd(rowOf("x"), { dataTransfer });
    expect(screen.queryByRole("region", { name: "Bookmarks" })).toBeNull();
  });
  it("bookmarks a session dropped on the Bookmarks header and reorders bookmarks", () => {
    vi.useFakeTimers();
    render(<Sidebar />);
    const dataTransfer = dt();
    fireEvent.dragStart(rowOf("x"), { dataTransfer });
    act(() => vi.runOnlyPendingTimers());
    const header = within(screen.getByRole("region", { name: "Bookmarks" })).getByText("Bookmarks");
    fireEvent.dragOver(header, { dataTransfer });
    fireEvent.drop(header, { dataTransfer });
    fireEvent.dragEnd(rowOf("x"), { dataTransfer });
    expect(useLayout.getState().layout.bookmarks).toEqual([kx]);
    act(() => useLayout.getState().update((l) => ({ ...l, bookmarks: [...l.bookmarks, ky] })));
    const bm = screen.getByRole("region", { name: "Bookmarks" });
    // jsdom rows have no height, so a session row resolves to "after": x moves after y.
    drag(within(bm).getByText("x").closest("button")!, within(bm).getByText("y").closest("button")!);
    expect(useLayout.getState().layout.bookmarks).toEqual([ky, kx]);
    // A bookmark drag over the tree changes nothing.
    const before = useLayout.getState().layout;
    drag(within(bm).getByText("x").closest("button")!, rowOf("A"));
    expect(useLayout.getState().layout).toBe(before);
  });
  it("opens a closed group after hovering 600 ms during a drag", () => {
    vi.useFakeTimers();
    useApp.setState({ expanded: { "group:a": false } });
    render(<Sidebar />);
    const dataTransfer = dt();
    fireEvent.dragStart(rowOf("x"), { dataTransfer });
    fireEvent.dragEnter(rowOf("A"), { dataTransfer });
    fireEvent.dragOver(rowOf("A"), { dataTransfer });
    act(() => vi.advanceTimersByTime(599));
    expect(useApp.getState().expanded["group:a"]).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(useApp.getState().expanded["group:a"]).toBe(true);
  });
  it("moves a session to the end of the root when dropped after the tree", () => {
    render(<Sidebar />);
    drag(rowOf("x"), document.querySelector(".tree-end") as HTMLElement);
    const tree = useLayout.getState().layout.tree;
    expect(tree.map((n) => (n.kind === "group" ? n.id : n.key))).toEqual(["a", ky, kx]);
  });
  it("does not bookmark a group", () => {
    render(<Sidebar />);
    const dataTransfer = dt();
    fireEvent.dragStart(rowOf("A"), { dataTransfer });
    expect(screen.queryByRole("region", { name: "Bookmarks" })).toBeNull();
    fireEvent.dragEnd(rowOf("A"), { dataTransfer });
    expect(useLayout.getState().layout.bookmarks).toEqual([]);
  });
});

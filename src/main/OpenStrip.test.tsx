import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useApp } from "../store/app";
import { OpenStrip } from "./OpenStrip";
import { itemKey, NO_ITEMS } from "../store/openItems";
import type { MachineView, PaneView } from "../lib/types";

const pane = (id: string, title: string, status: PaneView["status"]): PaneView => ({
  pane_id: id, terminal_id: "t" + id, title, cwd: "/x", agent: "claude", status,
});

const m: MachineView = {
  id: "local", label: "local", kind: "local", state: "connected", error: null, version: "0.9.3", status: "working",
  sessions: [{ name: "default", running: true, status: "working", error: null, workspaces: [
    { workspace_id: "w1", label: "remora", number: 1, status: "idle", tabs: [
      { tab_id: "w1:t1", label: "1", number: 1, status: "idle", panes: [pane("p1", "Mermaid diagram", "idle")] } ] },
    { workspace_id: "w2", label: "herdr-app", number: 2, status: "working", tabs: [
      { tab_id: "w2:t1", label: "1", number: 1, status: "working", panes: [pane("p2", "Chat tabs", "working"), pane("p3", "Bug button", "blocked")] } ] },
  ] }, { name: "pegabot", running: true, status: "idle", error: null, workspaces: [
    { workspace_id: "w1", label: "bot", number: 1, status: "idle", tabs: [
      { tab_id: "w1:t1", label: "1", number: 1, status: "idle", panes: [pane("p1", "Webhook retry", "done")] } ] },
  ] }],
};

const ref = (pane_id: string, session = "default") => ({ machine_id: "local", session, pane_id });
const open = () => useApp.getState().openItems.items.map((i) => (i.kind === "agent" ? i.ref.pane_id : i.rel));
// Selects each pane and pins its tab.
const openPinned = (...ids: string[]) => {
  for (const id of ids) {
    useApp.getState().select(ref(id));
    useApp.getState().pinItem(itemKey({ kind: "agent", ref: ref(id) }));
  }
};

describe("OpenStrip", () => {
  beforeEach(() => {
    useApp.setState({ machines: {}, order: [], selected: null, openItems: NO_ITEMS });
    useApp.getState().upsertMachine(m);
  });

  it("shows nothing until an agent is opened", () => {
    const { container } = render(<OpenStrip />);
    expect(container.firstChild).toBeNull();
  });

  it("lists the opened agents across workspaces and sessions, marking the selected one", () => {
    openPinned("p1");
    useApp.getState().select(ref("p1", "pegabot"));
    useApp.getState().pinItem(itemKey({ kind: "agent", ref: ref("p1", "pegabot") }));
    useApp.getState().select(ref("p3"));
    render(<OpenStrip />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Mermaid diagram", "Webhook retry", "Bug button"]);
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["false", "false", "true"]);
    expect(screen.getByRole("img", { name: "status blocked" })).toBeTruthy();
    expect(tabs[0].closest("[title]")?.getAttribute("title")).toBe("local/default · remora · Mermaid diagram");
    expect(tabs[1].closest("[title]")?.getAttribute("title")).toBe("local/pegabot · bot · Webhook retry");
    fireEvent.click(tabs[1]);
    expect(useApp.getState().selected).toEqual(ref("p1", "pegabot"));
  });

  it("italicises the preview tab and pins it on double click", () => {
    openPinned("p1");
    useApp.getState().select(ref("p2"));
    render(<OpenStrip />);
    const tab = screen.getByRole("tab", { name: /Chat tabs/ });
    expect(tab.className).toContain("preview");
    expect(screen.getByRole("tab", { name: /Mermaid diagram/ }).className).not.toContain("preview");
    fireEvent.doubleClick(tab);
    expect(useApp.getState().openItems.preview).toBeNull();
    expect(screen.getByRole("tab", { name: /Chat tabs/ }).className).not.toContain("preview");
  });

  it("selects on click; closes on the close button and on middle click", () => {
    openPinned("p1", "p2", "p3");
    render(<OpenStrip />);
    fireEvent.click(screen.getByRole("tab", { name: /Mermaid diagram/ }));
    expect(useApp.getState().selected).toEqual(ref("p1"));
    fireEvent.click(screen.getByRole("button", { name: "Close Chat tabs" }));
    expect(open()).toEqual(["p1", "p3"]);
    expect(useApp.getState().selected).toEqual(ref("p1"));
    fireEvent(screen.getByRole("tab", { name: /Bug button/ }), new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(open()).toEqual(["p1"]);
  });

  it("right click offers the close commands that would close something", () => {
    openPinned("p1", "p2");
    render(<OpenStrip />);
    fireEvent.contextMenu(screen.getByRole("tab", { name: /Chat tabs/ }));
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Close", "Close Others", "Close All"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Close Others" }));
    expect(open()).toEqual(["p2"]);
  });

  it("shows a file item by basename with its place in the tooltip, and activates it on click", () => {
    openPinned("p1");
    useApp.getState().openFile({ machine_id: "local", session: "default", workspace_id: "w2" }, "/r", "src/main.ts", { pin: true });
    useApp.getState().select(ref("p1"));
    render(<OpenStrip />);
    const tab = screen.getByRole("tab", { name: "main.ts" });
    expect(tab.closest(".files-tab-item")?.getAttribute("title")).toBe("local/default · herdr-app · src/main.ts");
    fireEvent.click(tab);
    expect(useApp.getState().openItems.active).toBe("file:local/default/w2|/r|src/main.ts");
    expect(useApp.getState().selected).toEqual(ref("p1"));
  });

  it("marks the active item, not the selected pane, as selected", () => {
    openPinned("p1");
    useApp.getState().openFile({ machine_id: "local", session: "default", workspace_id: "w2" }, "/r", "a.md", { pin: true });
    render(<OpenStrip />);
    expect(screen.getByRole("tab", { name: "a.md" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Mermaid diagram" }).getAttribute("aria-selected")).toBe("false");
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue([]), Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import App from "./App";
import { useApp } from "./store/app";

describe("App shell", () => {
  it("renders the sidebar and the empty main area", () => {
    render(<App />);
    expect(screen.getByRole("navigation", { name: "Machines" })).toBeTruthy();
    expect(screen.getByText("Select a pane")).toBeTruthy();
  });

  it("offers to start the default session when local has none running", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    (invoke as any).mockResolvedValueOnce([{ id: "local", label: "local", kind: "local", state: "connected", error: null, version: "0.9.3", status: "unknown",
      sessions: [{ name: "default", running: false, status: "unknown", error: null, workspaces: [] }] }]);
    render(<App />);
    expect(await screen.findByRole("button", { name: "Start default session" })).toBeTruthy();
  });

  it("shows a toast when starting the default session fails", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    (invoke as any).mockResolvedValueOnce([{ id: "local", label: "local", kind: "local", state: "connected", error: null, version: "0.9.3", status: "unknown",
      sessions: [{ name: "default", running: false, status: "unknown", error: null, workspaces: [] }] }]);
    render(<App />);
    const start = await screen.findByRole("button", { name: "Start default session" });
    (invoke as any).mockImplementation((cmd: string) => (cmd === "session_start" ? Promise.reject({ code: "timeout", message: "did not start" }) : Promise.resolve([])));
    fireEvent.click(start);
    expect(await screen.findByText("Could not start the default session: did not start")).toBeTruthy();
    (invoke as any).mockImplementation(() => Promise.resolve([]));
  });

  it("explains when herdr is missing", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    (invoke as any).mockResolvedValueOnce([{ id: "local", label: "local", kind: "local", state: "error", error: { code: "herdr_not_found", message: "herdr not found" }, version: null, status: "unknown", sessions: [] }]);
    render(<App />);
    expect(await screen.findByText("herdr is not installed on this Mac")).toBeTruthy();
  });

  it("opens the Agent Dashboard over the main area from the sidebar, keeping the main area mounted", () => {
    useApp.setState({ machines: {}, order: [], selected: null, dashboardOpen: false });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /agent dashboard/i }));
    expect(screen.getByRole("dialog", { name: "Agent Dashboard" })).toBeTruthy();
    expect(screen.getByText("Select a pane")).toBeTruthy();
    // ⌘K searches the dashboard instead of opening the palette.
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Agent Dashboard" })).toBeNull();
  });

  it("shows the loading overlay, not the empty state, while a new pane's agent starts before herdr reports the pane", () => {
    const pane = { machine_id: "local", session: "default", pane_id: "w1:p7" };
    useApp.setState({ machines: {}, order: [], selected: pane, dashboardOpen: false, starting: { "local/default/w1:p7": { agent: "claude", phase: "shell" } } });
    render(<App />);
    expect(screen.getByText("Waiting for the shell…")).toBeTruthy();
    expect(screen.queryByText("Select a pane")).toBeNull();
    useApp.setState({ selected: null, starting: {} });
  });

  it("keeps file drops from navigating the webview, leaving sidebar drags alone", () => {
    render(<App />);
    expect(fireEvent.dragOver(document, { dataTransfer: { types: ["Files"] } })).toBe(false);
    expect(fireEvent.drop(document, { dataTransfer: { types: ["Files"] } })).toBe(false);
    expect(fireEvent.dragOver(document, { dataTransfer: { types: ["application/x-herdr-node"] } })).toBe(true);
    expect(fireEvent.drop(document, { dataTransfer: { types: ["application/x-herdr-node"] } })).toBe(true);
  });
});

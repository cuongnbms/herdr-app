import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue([]), Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import App from "./App";

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

  it("explains when herdr is missing", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    (invoke as any).mockResolvedValueOnce([{ id: "local", label: "local", kind: "local", state: "error", error: { code: "herdr_not_found", message: "herdr not found" }, version: null, status: "unknown", sessions: [] }]);
    render(<App />);
    expect(await screen.findByText("herdr is not installed on this Mac")).toBeTruthy();
  });
});

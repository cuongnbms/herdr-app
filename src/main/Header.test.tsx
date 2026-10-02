import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useApp } from "../store/app";
import { Header } from "./Header";
import type { MachineView } from "../lib/types";

const m: MachineView = {
  id: "local", label: "local", kind: "local", state: "connected", error: null, version: "0.9.3", status: "blocked",
  sessions: [{ name: "default", running: true, status: "blocked", error: null, workspaces: [
    { workspace_id: "w1", label: "herdr-app", number: 1, status: "blocked", tabs: [
      { tab_id: "w1:t1", label: "1", number: 1, status: "blocked", panes: [
        { pane_id: "w1:p1", terminal_id: "a", title: "Rewrite", cwd: "/x", agent: "claude", status: "blocked" } ] } ] } ] }],
};

describe("Header", () => {
  beforeEach(() => useApp.setState({
    machines: { local: m }, order: ["local"], lens: {},
    selected: { machine_id: "local", session: "default", pane_id: "w1:p1" },
  }));
  it("shows breadcrumb and agent status, and switches lens", () => {
    render(<Header />);
    expect(screen.getByLabelText("Breadcrumb").textContent).toBe("local › default › herdr-app › Rewrite");
    expect(screen.getByLabelText("status blocked")).toBeTruthy();
    expect(screen.getByText("claude · blocked")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(useApp.getState().lens["local/default/w1:p1"]).toBe("chat");
  });
});

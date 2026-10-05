import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { paneKey } from "../lib/types";
import { useApp } from "../store/app";
import { StartingOverlay } from "./StartingOverlay";

const pane = { machine_id: "local", session: "default", pane_id: "w1:p7" };

describe("StartingOverlay", () => {
  beforeEach(() => useApp.setState({ starting: {} }));

  it("covers the terminal while the pane's agent starts, then goes away", () => {
    render(<StartingOverlay pane={pane} />);
    expect(screen.queryByRole("status")).toBeNull();
    act(() => useApp.getState().setStarting(paneKey(pane), { agent: "claude", phase: "shell" }));
    expect(screen.getByRole("status").textContent).toBe("Waiting for the shell…");
    act(() => useApp.getState().setStarting(paneKey(pane), { agent: "claude", phase: "agent" }));
    expect(screen.getByRole("status").textContent).toBe("Starting claude…");
    act(() => useApp.getState().setStarting(paneKey(pane), null));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("ignores other panes starting", () => {
    render(<StartingOverlay pane={pane} />);
    act(() => useApp.getState().setStarting(paneKey({ ...pane, pane_id: "w1:p8" }), { agent: "pi", phase: "shell" }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ herdrCall: vi.fn() }));
import { herdrCall } from "../lib/ipc";
import { paneKey } from "../lib/types";
import { useApp } from "../store/app";
import { getFolder } from "../workspaces/folder";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog";

// herdr reports a started agent in the pane in its next snapshot, which ends launchAgent's wait.
const reportAgent = (paneId: string, kind: string) =>
  useApp.getState().upsertMachine({
    id: "local", label: "local", kind: "local", state: "connected", error: null, version: "0.9.3", status: "idle",
    sessions: [{ name: "default", running: true, status: "idle", error: null, workspaces: [
      { workspace_id: "w0", label: "x", number: 1, status: "idle", tabs: [
        { tab_id: "w0:t1", label: "1", number: 1, status: "idle", panes: [
          { pane_id: paneId, terminal_id: "t0", title: kind, cwd: null, agent: kind, status: "idle" } ] } ] } ] }],
  });
const started = (params: unknown) => {
  const { pane_id, kind } = params as { pane_id: string; kind: string };
  reportAgent(pane_id, kind);
  return Promise.resolve(undefined);
};

describe("NewWorkspaceDialog", () => {
  beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });

  it("stores the directory as the new workspace's folder", async () => {
    vi.mocked(herdrCall).mockResolvedValue({ type: "workspace_created", workspace: { workspace_id: "w5" }, root_pane: { pane_id: "w5:p1" } });
    render(<NewWorkspaceDialog machineId="local" session="default" defaultCwd="" onClose={() => {}} onError={() => {}} />);
    fireEvent.change(screen.getByLabelText("Directory"), { target: { value: " /srv/api " } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(getFolder({ machine_id: "local", session: "default", workspace_id: "w5" })).toBe("/srv/api"));
  });

  it("stores nothing when the directory is empty", async () => {
    vi.mocked(herdrCall).mockResolvedValue({ type: "workspace_created", workspace: { workspace_id: "w6" }, root_pane: { pane_id: "w6:p1" } });
    render(<NewWorkspaceDialog machineId="local" session="default" defaultCwd="" onClose={() => {}} onError={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(herdrCall).toHaveBeenCalled());
    expect(getFolder({ machine_id: "local", session: "default", workspace_id: "w6" })).toBeNull();
  });
  it("still starts the agent when the reply has no workspace", async () => {
    const onError = vi.fn();
    vi.mocked(herdrCall).mockImplementation((_m, _s, method, params) =>
      method === "workspace.create" ? Promise.resolve({ type: "workspace_created", root_pane: { pane_id: "w8:p1" } }) : started(params));
    render(<NewWorkspaceDialog machineId="local" session="default" defaultCwd="/srv/api" onClose={() => {}} onError={onError} />);
    fireEvent.click(screen.getByRole("radio", { name: "claude" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(herdrCall).toHaveBeenCalledWith("local", "default", "agent.start", { name: "claude", kind: "claude", pane_id: "w8:p1" }));
    expect(onError).not.toHaveBeenCalled();
    expect(useApp.getState().lensOverride[paneKey({ machine_id: "local", session: "default", pane_id: "w8:p1" })]).toBe("terminal");
  });
  it("opens a new pi agent on the Terminal too", async () => {
    vi.mocked(herdrCall).mockImplementation((_m, _s, method, params) =>
      method === "workspace.create" ? Promise.resolve({ type: "workspace_created", workspace: { workspace_id: "w9" }, root_pane: { pane_id: "w9:p1" } }) : started(params));
    render(<NewWorkspaceDialog machineId="local" session="default" defaultCwd="/srv/api" onClose={() => {}} onError={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: "pi" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(herdrCall).toHaveBeenCalledWith("local", "default", "agent.start", { name: "pi", kind: "pi", pane_id: "w9:p1" }));
    expect(useApp.getState().lensOverride[paneKey({ machine_id: "local", session: "default", pane_id: "w9:p1" })]).toBe("terminal");
  });
});

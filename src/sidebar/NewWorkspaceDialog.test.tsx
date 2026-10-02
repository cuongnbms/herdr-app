import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ herdrCall: vi.fn() }));
import { herdrCall } from "../lib/ipc";
import { getFolder } from "../workspaces/folder";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog";

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
    vi.mocked(herdrCall).mockImplementation((_m, _s, method) =>
      Promise.resolve(method === "workspace.create" ? { type: "workspace_created", root_pane: { pane_id: "w8:p1" } } : undefined));
    render(<NewWorkspaceDialog machineId="local" session="default" defaultCwd="/srv/api" onClose={() => {}} onError={onError} />);
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "claude" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(herdrCall).toHaveBeenCalledWith("local", "default", "agent.start", { name: "claude", kind: "claude", pane_id: "w8:p1" }));
    expect(onError).not.toHaveBeenCalled();
  });
});

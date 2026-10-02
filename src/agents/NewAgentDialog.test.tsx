import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ herdrCall: vi.fn() }));
import { herdrCall } from "../lib/ipc";
import { useApp } from "../store/app";
import { getFolder, setFolder } from "../workspaces/folder";
import { NewAgentDialog } from "./NewAgentDialog";
import type { WorkspaceView } from "../lib/types";

const ws: WorkspaceView = { workspace_id: "w1", label: "api", number: 1, status: "idle", tabs: [
  { tab_id: "w1:t1", label: "1", number: 1, status: "idle", panes: [
    { pane_id: "w1:p1", terminal_id: "t1", title: "sh", cwd: "/srv/api", agent: null, status: "unknown" } ] } ] };
const ref = { machine_id: "local", session: "default", workspace_id: "w1" };

function respond(agentStart: () => Promise<unknown> = () => Promise.resolve(undefined)) {
  vi.mocked(herdrCall).mockImplementation((_m, _s, method) =>
    method === "tab.create"
      ? Promise.resolve({ type: "tab_created", tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p7" } })
      : agentStart());
}
const open = (onError = vi.fn()) => {
  const onClose = vi.fn();
  render(<NewAgentDialog machineId="local" session="default" workspace={ws} onClose={onClose} onError={onError} />);
  return { onClose, onError };
};

describe("NewAgentDialog", () => {
  beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); useApp.setState({ selected: null }); });

  it("asks for the folder the first time, prefilled from the first pane, and remembers it", async () => {
    respond();
    open();
    expect(screen.getByRole("dialog", { name: "New agent" })).toBeTruthy();
    expect((screen.getByLabelText("Folder") as HTMLInputElement).value).toBe("/srv/api");
    fireEvent.change(screen.getByLabelText("Folder"), { target: { value: "/srv/api2 " } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(herdrCall).toHaveBeenCalledTimes(2));
    expect(getFolder(ref)).toBe("/srv/api2");
    expect(herdrCall).toHaveBeenNthCalledWith(1, "local", "default", "tab.create", { workspace_id: "w1", cwd: "/srv/api2", label: "claude", focus: false });
    expect(herdrCall).toHaveBeenNthCalledWith(2, "local", "default", "agent.start", { name: "claude", kind: "claude", pane_id: "w1:p7" });
    expect(useApp.getState().selected).toEqual({ machine_id: "local", session: "default", pane_id: "w1:p7" });
  });

  it("uses the remembered folder without asking", async () => {
    setFolder(ref, "/home/me/api");
    respond();
    open();
    expect(screen.queryByLabelText("Folder")).toBeNull();
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "pi" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(herdrCall).toHaveBeenCalledTimes(2));
    expect(herdrCall).toHaveBeenNthCalledWith(1, "local", "default", "tab.create", { workspace_id: "w1", cwd: "/home/me/api", label: "pi", focus: false });
    expect(herdrCall).toHaveBeenNthCalledWith(2, "local", "default", "agent.start", { name: "pi", kind: "pi", pane_id: "w1:p7" });
  });

  it("does nothing for a blank folder", () => {
    respond();
    const { onClose } = open();
    fireEvent.change(screen.getByLabelText("Folder"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(herdrCall).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(getFolder(ref)).toBeNull();
  });

  it("reports an agent.start failure and keeps the new pane selected", async () => {
    respond(() => Promise.reject({ code: "timeout", message: "agent did not become ready" }));
    const { onError } = open();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("agent did not become ready"));
    expect(useApp.getState().selected?.pane_id).toBe("w1:p7");
  });
});

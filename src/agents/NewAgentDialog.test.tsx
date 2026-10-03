import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ herdrCall: vi.fn() }));
import { herdrCall } from "../lib/ipc";
import { paneKey } from "../lib/types";
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
  beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); useApp.setState({ selected: null, lensOverride: {} }); });
  const newKey = paneKey({ machine_id: "local", session: "default", pane_id: "w1:p7" });

  it("opens a new agent's pane in the Terminal lens, without a note, until its transcript exists", async () => {
    setFolder(ref, "/home/me/api");
    let lensWhenSelected: unknown;
    useApp.subscribe((s, prev) => {
      if (s.selected && !prev.selected) lensWhenSelected = s.lensOverride[newKey];
    });
    respond();
    open();
    fireEvent.click(screen.getByRole("button", { name: "claude" }));
    await waitFor(() => expect(herdrCall).toHaveBeenCalledTimes(2));
    expect(lensWhenSelected).toBe("terminal");
  });

  it("opens a plain shell tab without starting an agent", async () => {
    setFolder(ref, "/home/me/api");
    respond();
    const { onError } = open();
    fireEvent.click(screen.getByRole("button", { name: "shell" }));
    await waitFor(() => expect(useApp.getState().selected?.pane_id).toBe("w1:p7"));
    expect(herdrCall).toHaveBeenCalledTimes(1);
    expect(herdrCall).toHaveBeenCalledWith("local", "default", "tab.create", { workspace_id: "w1", cwd: "/home/me/api", label: "shell", focus: false });
    expect(useApp.getState().lensOverride[newKey]).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });

  it("asks for the folder the first time, prefilled from the first pane, and remembers it", async () => {
    respond();
    open();
    expect(screen.getByRole("dialog", { name: "New agent" })).toBeTruthy();
    expect((screen.getByLabelText("Folder") as HTMLInputElement).value).toBe("/srv/api");
    fireEvent.change(screen.getByLabelText("Folder"), { target: { value: "/srv/api2 " } });
    fireEvent.click(screen.getByRole("button", { name: "claude" }));
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
    fireEvent.click(screen.getByRole("button", { name: "pi" }));
    await waitFor(() => expect(herdrCall).toHaveBeenCalledTimes(2));
    expect(herdrCall).toHaveBeenNthCalledWith(1, "local", "default", "tab.create", { workspace_id: "w1", cwd: "/home/me/api", label: "pi", focus: false });
    expect(herdrCall).toHaveBeenNthCalledWith(2, "local", "default", "agent.start", { name: "pi", kind: "pi", pane_id: "w1:p7" });
    // Only Claude is known to have no transcript yet; pi keeps the Chat lens's own fallback.
    expect(useApp.getState().lensOverride[newKey]).toBeUndefined();
  });

  it("does nothing for a blank folder", () => {
    respond();
    const { onClose } = open();
    fireEvent.change(screen.getByLabelText("Folder"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "claude" }));
    expect(herdrCall).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(getFolder(ref)).toBeNull();
  });

  it("reports an agent.start failure and keeps the new pane selected", async () => {
    respond(() => Promise.reject({ code: "timeout", message: "agent did not become ready" }));
    const { onError } = open();
    fireEvent.click(screen.getByRole("button", { name: "claude" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("agent did not become ready"));
    expect(useApp.getState().selected?.pane_id).toBe("w1:p7");
  });
  it("offers each agent as a start button, below the folder, with no Cancel or Start", () => {
    respond();
    open();
    const group = screen.getByRole("group", { name: "Agent" });
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["claude", "pi", "shell"]);
    expect(screen.getByLabelText("Folder").compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("starts claude on Enter in the folder field", async () => {
    respond();
    open();
    fireEvent.submit(screen.getByLabelText("Folder"));
    await waitFor(() => expect(herdrCall).toHaveBeenCalledTimes(2));
    expect(herdrCall).toHaveBeenNthCalledWith(1, "local", "default", "tab.create", { workspace_id: "w1", cwd: "/srv/api", label: "claude", focus: false });
  });

  it("focuses the first agent when the folder is remembered, and Escape closes", () => {
    setFolder(ref, "/home/me/api");
    respond();
    const { onClose } = open();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "claude" }));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("reports a tab.create failure without starting an agent", async () => {
    vi.mocked(herdrCall).mockImplementation((_m, _s, method) =>
      method === "tab.create" ? Promise.reject({ code: "io", message: "no such workspace" }) : Promise.resolve(undefined));
    const { onError } = open();
    fireEvent.change(screen.getByLabelText("Folder"), { target: { value: "/srv/x" } });
    fireEvent.click(screen.getByRole("button", { name: "claude" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("no such workspace"));
    expect(herdrCall).toHaveBeenCalledTimes(1);
    expect(herdrCall).not.toHaveBeenCalledWith("local", "default", "agent.start", expect.anything());
    expect(useApp.getState().selected).toBeNull();
    expect(getFolder(ref)).toBe("/srv/x");
  });
});

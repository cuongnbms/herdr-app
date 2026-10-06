import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ sessionStart: vi.fn() }));
import { sessionStart } from "../lib/ipc";
import type { MachineView } from "../lib/types";
import { useApp } from "../store/app";
import { EMPTY_LAYOUT, sessionKey, useLayout } from "./groups";
import { NewSessionDialog } from "./NewSessionDialog";

const create = () => fireEvent.click(screen.getByRole("button", { name: "Create" }));
const name = (value: string) => fireEvent.change(screen.getByLabelText("Name"), { target: { value } });

const machine = (id: string, sessions: string[], state: MachineView["state"] = "connected"): MachineView => ({
  id, label: id, kind: "ssh", state, error: null, version: "0.9.3", status: "unknown",
  sessions: sessions.map((s) => ({ name: s, running: true, status: "unknown", error: null, workspaces: [] })),
});
const set = (machines: MachineView[]) =>
  useApp.setState({ machines: Object.fromEntries(machines.map((m) => [m.id, m])), order: machines.map((m) => m.id), viewed: null });

describe("NewSessionDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useLayout.setState({ layout: EMPTY_LAYOUT });
    set([machine("box", ["default"])]);
  });

  it("starts the named session and opens it", async () => {
    vi.mocked(sessionStart).mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<NewSessionDialog machineId="box" onClose={onClose} onError={() => {}} />);
    expect(screen.queryByLabelText("Machine")).toBeNull();
    name(" api ");
    create();
    expect(onClose).toHaveBeenCalled();
    expect(sessionStart).toHaveBeenCalledWith("box", "api");
    await waitFor(() => expect(useApp.getState().viewed).toEqual({ machine_id: "box", session: "api" }));
  });

  it("rejects an invalid name without calling herdr", () => {
    render(<NewSessionDialog machineId="box" onClose={() => {}} onError={() => {}} />);
    for (const bad of ["", "-x", "a b", "a/b"]) {
      name(bad);
      create();
    }
    expect(sessionStart).not.toHaveBeenCalled();
    name("a b");
    expect(screen.getByRole("button", { name: "Create" })).toHaveProperty("disabled", true);
  });

  it("rejects a name the machine already has", () => {
    render(<NewSessionDialog machineId="box" onClose={() => {}} onError={() => {}} />);
    name("default");
    create();
    expect(sessionStart).not.toHaveBeenCalled();
    expect(screen.getByText(/already exists/)).toBeTruthy();
  });

  it("reports a failed start and opens nothing", async () => {
    vi.mocked(sessionStart).mockRejectedValue({ code: "timeout", message: "session api did not start within 10s" });
    const onError = vi.fn();
    render(<NewSessionDialog machineId="box" onClose={() => {}} onError={onError} />);
    name("api");
    create();
    await waitFor(() => expect(onError).toHaveBeenCalledWith("session api did not start within 10s"));
    expect(useApp.getState().viewed).toBeNull();
  });

  it("without a machine, picks among connected machines and checks names on the chosen one", async () => {
    vi.mocked(sessionStart).mockResolvedValue(undefined);
    set([machine("off", [], "disconnected"), machine("box", ["api"]), machine("lab", ["web"])]);
    render(<NewSessionDialog onClose={() => {}} onError={() => {}} />);
    const picker = screen.getByLabelText("Machine") as HTMLSelectElement;
    expect([...picker.options].map((o) => o.value)).toEqual(["box", "lab"]);
    expect(picker.value).toBe("box");
    name("api");
    expect(screen.getByText(/already exists/)).toBeTruthy();
    fireEvent.change(picker, { target: { value: "lab" } });
    expect(screen.queryByText(/already exists/)).toBeNull();
    create();
    expect(sessionStart).toHaveBeenCalledWith("lab", "api");
    await waitFor(() => expect(useApp.getState().viewed).toEqual({ machine_id: "lab", session: "api" }));
  });

  it("places the new session into the given group", async () => {
    vi.mocked(sessionStart).mockResolvedValue(undefined);
    useLayout.setState({ layout: { tree: [{ kind: "group", id: "g", label: "Work", children: [] }], bookmarks: [] } });
    render(<NewSessionDialog groupId="g" onClose={() => {}} onError={() => {}} />);
    name("api");
    create();
    await waitFor(() =>
      expect(useLayout.getState().layout.tree).toEqual([
        { kind: "group", id: "g", label: "Work", children: [{ kind: "session", key: sessionKey("box", "api") }] },
      ]),
    );
  });
});

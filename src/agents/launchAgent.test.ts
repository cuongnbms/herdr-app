import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { paneKey, type MachineView } from "../lib/types";
import { useApp } from "../store/app";
import { launchAgent } from "./launchAgent";

const pane = { machine_id: "local", session: "default", pane_id: "w1:p7" };
const key = paneKey(pane);
const busy = { code: "herdr_error", message: "agent target pane w1:p7 is not an available shell" };

const machine = (agent: string | null): MachineView => ({
  id: "local", label: "local", kind: "local", state: "connected", error: null, version: "0.9.3", status: "idle",
  sessions: [{ name: "default", running: true, status: "idle", error: null, workspaces: [
    { workspace_id: "w1", label: "api", number: 1, status: "idle", tabs: [
      { tab_id: "w1:t2", label: "claude", number: 2, status: "idle", panes: [
        { pane_id: "w1:p7", terminal_id: "t7", title: "sh", cwd: "/srv/api", agent, status: "idle" },
      ] },
    ] },
  ] }],
});

describe("launchAgent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useApp.setState({ machines: {}, order: [], selected: null, lensOverride: {}, starting: {} });
    useApp.getState().upsertMachine(machine(null));
  });
  afterEach(() => vi.useRealTimers());

  it("marks the pane starting until herdr reports the agent in it", async () => {
    const call = vi.fn().mockRejectedValueOnce(busy).mockResolvedValueOnce({ ok: true });
    const done = launchAgent(call, pane, "claude");
    expect(useApp.getState().starting[key]).toEqual({ agent: "claude", phase: "shell" });
    await vi.advanceTimersByTimeAsync(300);
    expect(call).toHaveBeenCalledWith("agent.start", { name: "claude", kind: "claude", pane_id: "w1:p7" });
    expect(useApp.getState().starting[key]).toEqual({ agent: "claude", phase: "agent" });
    useApp.getState().upsertMachine(machine("claude"));
    await expect(done).resolves.toBeUndefined();
    expect(useApp.getState().starting[key]).toBeUndefined();
  });

  it("resolves at once when the agent is already reported", async () => {
    useApp.getState().upsertMachine(machine("claude"));
    await expect(launchAgent(vi.fn().mockResolvedValue({ ok: true }), pane, "claude")).resolves.toBeUndefined();
    expect(useApp.getState().starting[key]).toBeUndefined();
  });

  it("gives up after 5s when the agent never shows up", async () => {
    const done = launchAgent(vi.fn().mockResolvedValue({ ok: true }), pane, "claude");
    const failed = expect(done).rejects.toThrow("claude did not start within 5s");
    await vi.advanceTimersByTimeAsync(4999);
    expect(useApp.getState().starting[key]).toBeDefined();
    await vi.advanceTimersByTimeAsync(1);
    await failed;
    expect(useApp.getState().starting[key]).toBeUndefined();
  });

  it("stops retrying a busy shell at the same 5s deadline", async () => {
    const call = vi.fn().mockRejectedValue(busy);
    const done = launchAgent(call, pane, "claude");
    const failed = expect(done).rejects.toBe(busy);
    await vi.advanceTimersByTimeAsync(5300);
    await failed;
    const calls = call.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(call).toHaveBeenCalledTimes(calls);
    expect(useApp.getState().starting[key]).toBeUndefined();
  });

  it("clears the overlay when agent.start fails outright", async () => {
    const err = { code: "herdr_error", message: "unknown agent kind" };
    await expect(launchAgent(vi.fn().mockRejectedValue(err), pane, "claude")).rejects.toBe(err);
    expect(useApp.getState().starting[key]).toBeUndefined();
  });
});

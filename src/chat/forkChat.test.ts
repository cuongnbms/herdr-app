import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ chatFork: vi.fn(), herdrCall: vi.fn() }));
vi.mock("../ui/Toast", () => ({ showToast: vi.fn() }));
vi.mock("../settings/lens", () => ({ newAgentOnTerminal: () => true }));
import { chatFork, herdrCall } from "../lib/ipc";
import { paneKey, type Located, type MachineView } from "../lib/types";
import { useApp } from "../store/app";
import { showToast } from "../ui/Toast";
import { readDraft } from "./drafts";
import { canFork, forkChat } from "./forkChat";

const pane = { machine_id: "local", session: "default", pane_id: "w1:p1" };
const fresh = { machine_id: "local", session: "default", pane_id: "w1:p9" };
const machine = (agentInNew: string | null): MachineView => ({
  id: "local", label: "local", kind: "local", state: "connected", error: null, version: "0.9.3", status: "idle",
  sessions: [{ name: "default", running: true, status: "idle", error: null, workspaces: [
    { workspace_id: "w1", label: "api", number: 1, status: "idle", tabs: [
      { tab_id: "w1:t1", label: "claude", number: 1, status: "idle", panes: [
        { pane_id: "w1:p1", terminal_id: "t1", title: "c", cwd: "/pane/cwd", agent: "claude", status: "idle" },
      ] },
      { tab_id: "w1:t9", label: "claude", number: 2, status: "idle", panes: [
        { pane_id: "w1:p9", terminal_id: "t9", title: "c", cwd: "/w/b", agent: agentInNew, status: "idle" },
      ] },
    ] },
  ] }],
});
const located = (o: Partial<Located> = {}): Located => ({ agent: "claude", path: "/p/old.jsonl", ambiguous: false, candidates: [], pending: false, ...o });

describe("canFork", () => {
  it("needs claude or pi and a located, certain transcript", () => {
    expect(canFork("claude", located())).toBe(true);
    expect(canFork("pi", located({ agent: "pi" }))).toBe(true);
    expect(canFork("codex", located())).toBe(false);
    expect(canFork("claude", null)).toBe(false);
    expect(canFork("claude", located({ pending: true }))).toBe(false);
    expect(canFork("claude", located({ ambiguous: true }))).toBe(false);
  });
});

describe("forkChat", () => {
  beforeEach(() => {
    vi.mocked(chatFork).mockReset();
    vi.mocked(herdrCall).mockReset();
    vi.mocked(showToast).mockReset();
    localStorage.clear();
    useApp.setState({ machines: {}, order: [], selected: null, lensOverride: {}, starting: {} });
    useApp.getState().upsertMachine(machine("claude"));
  });

  it("opens a tab at the fork's cwd, fills the draft and resumes the new session on Chat", async () => {
    vi.mocked(chatFork).mockResolvedValue({ id: "s2", path: "/p/s2.jsonl", cwd: "/w/b" });
    vi.mocked(herdrCall).mockImplementation(async (_m, _s, method) =>
      method === "tab.create" ? { root_pane: { pane_id: "w1:p9" } } : { ok: true });
    await forkChat(pane, "claude", "/p/old.jsonl", { id: "u4", text: "three" });
    expect(chatFork).toHaveBeenCalledWith("local", "claude", "/p/old.jsonl", "u4");
    expect(herdrCall).toHaveBeenCalledWith("local", "default", "tab.create", expect.objectContaining({ workspace_id: "w1", cwd: "/w/b" }));
    expect(herdrCall).toHaveBeenCalledWith("local", "default", "agent.start", { name: "claude", kind: "claude", pane_id: "w1:p9", args: ["--resume", "s2"] });
    expect(readDraft(paneKey(fresh))).toBe("three");
    expect(useApp.getState().lensOverride[paneKey(fresh)]).toBe("chat");
    expect(showToast).not.toHaveBeenCalled();
  });

  it("starts pi on the new session file", async () => {
    vi.mocked(chatFork).mockResolvedValue({ id: "s2", path: "/p/x_s2.jsonl", cwd: "/w/b" });
    vi.mocked(herdrCall).mockImplementation(async (_m, _s, method) =>
      method === "tab.create" ? { root_pane: { pane_id: "w1:p9" } } : { ok: true });
    useApp.getState().upsertMachine(machine("pi"));
    await forkChat(pane, "pi", "/p/old.jsonl", { id: "c", text: "again" });
    expect(herdrCall).toHaveBeenCalledWith("local", "default", "agent.start", { name: "pi", kind: "pi", pane_id: "w1:p9", args: ["--session", "/p/x_s2.jsonl"] });
  });

  it("starts a plain agent at the pane's cwd when there is nothing before the message", async () => {
    vi.mocked(chatFork).mockResolvedValue({ id: null, path: null, cwd: null });
    vi.mocked(herdrCall).mockImplementation(async (_m, _s, method) =>
      method === "tab.create" ? { root_pane: { pane_id: "w1:p9" } } : { ok: true });
    await forkChat(pane, "claude", "/p/old.jsonl", { id: "u1", text: "one" });
    expect(herdrCall).toHaveBeenCalledWith("local", "default", "tab.create", expect.objectContaining({ cwd: "/pane/cwd" }));
    expect(herdrCall).toHaveBeenCalledWith("local", "default", "agent.start", { name: "claude", kind: "claude", pane_id: "w1:p9" });
    expect(readDraft(paneKey(fresh))).toBe("one");
  });

  it("toasts a failure", async () => {
    vi.mocked(chatFork).mockRejectedValue({ code: "not_found", message: "entry u9 not found in transcript" });
    await forkChat(pane, "claude", "/p/old.jsonl", { id: "u9", text: "x" });
    expect(showToast).toHaveBeenCalledWith("Could not fork: entry u9 not found in transcript");
    expect(herdrCall).not.toHaveBeenCalled();
  });
});

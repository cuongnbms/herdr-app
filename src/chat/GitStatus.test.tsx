import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ chatGitStatus: vi.fn() }));
import { chatGitStatus } from "../lib/ipc";
import { GitStatusLine } from "./GitStatus";

const pane = { machine_id: "devtuf", session: "default", pane_id: "w1:p1" };
const status = (over = {}) => ({ folder: "herdr-app", path: "/Users/me/herdr-app", branch: "main", dirty: false, ...over });

beforeEach(() => {
  vi.mocked(chatGitStatus).mockReset().mockResolvedValue(status());
});

describe("GitStatusLine", () => {
  it("shows the folder and a clean branch", async () => {
    render(<GitStatusLine pane={pane} status="idle" />);
    expect(await screen.findByText("herdr-app")).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByLabelText("clean")).toBeTruthy();
    expect(screen.getByTitle(/\/Users\/me\/herdr-app/)).toBeTruthy();
  });

  it("marks uncommitted changes", async () => {
    vi.mocked(chatGitStatus).mockResolvedValue(status({ dirty: true }));
    render(<GitStatusLine pane={pane} status="idle" />);
    expect(await screen.findByLabelText("uncommitted changes")).toBeTruthy();
  });

  it("shows only the folder outside a repository", async () => {
    vi.mocked(chatGitStatus).mockResolvedValue(status({ branch: null }));
    render(<GitStatusLine pane={pane} status="idle" />);
    expect(await screen.findByText("herdr-app")).toBeTruthy();
    expect(screen.queryByText("main")).toBeNull();
  });

  it("renders nothing without a working directory or on failure", async () => {
    vi.mocked(chatGitStatus).mockResolvedValue(null);
    const { container, unmount } = render(<GitStatusLine pane={pane} status="idle" />);
    await waitFor(() => expect(chatGitStatus).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
    unmount();
    vi.mocked(chatGitStatus).mockRejectedValue({ code: "timeout", message: "slow" });
    const r = render(<GitStatusLine pane={pane} status="idle" />);
    await waitFor(() => expect(chatGitStatus).toHaveBeenCalledTimes(2));
    expect(r.container.innerHTML).toBe("");
  });

  it("refreshes when a turn ends and when the window regains focus", async () => {
    const { rerender } = render(<GitStatusLine pane={pane} status="working" />);
    expect(await screen.findByText("main")).toBeTruthy();
    vi.mocked(chatGitStatus).mockResolvedValue(status({ branch: "feature" }));
    rerender(<GitStatusLine pane={pane} status="working" />);
    expect(chatGitStatus).toHaveBeenCalledTimes(1);
    rerender(<GitStatusLine pane={pane} status="done" />);
    expect(await screen.findByText("feature")).toBeTruthy();
    expect(chatGitStatus).toHaveBeenCalledTimes(2);
    act(() => void window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(chatGitStatus).toHaveBeenCalledTimes(3));
  });

  it("refetches for another pane and drops a stale answer", async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    vi.mocked(chatGitStatus)
      .mockReturnValueOnce(new Promise((r) => (resolveFirst = r)) as never)
      .mockResolvedValueOnce(status({ folder: "other" }));
    const { rerender } = render(<GitStatusLine pane={pane} status="idle" />);
    rerender(<GitStatusLine pane={{ ...pane, pane_id: "w1:p2" }} status="idle" />);
    expect(await screen.findByText("other")).toBeTruthy();
    await act(async () => resolveFirst(status({ folder: "stale" })));
    expect(screen.queryByText("stale")).toBeNull();
  });
});

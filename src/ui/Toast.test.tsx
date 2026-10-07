import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { showProgressToast, showToast, Toasts, updateToast } from "./Toast";

describe("Toast", () => {
  afterEach(() => vi.useRealTimers());
  it("shows a message and dismisses it after 5 s", () => {
    vi.useFakeTimers();
    render(<Toasts />);
    act(() => showToast("pane.read timed out"));
    expect(screen.getByText("pane.read timed out")).toBeTruthy();
    act(() => void vi.advanceTimersByTime(5000));
    expect(screen.queryByText("pane.read timed out")).toBeNull();
  });

  it("keeps a progress toast until it is updated, then dismisses it 5 s later", () => {
    vi.useFakeTimers();
    render(<Toasts />);
    let id = 0;
    act(() => void (id = showProgressToast("Uploading a.md to /…")));
    act(() => void vi.advanceTimersByTime(60_000));
    expect(screen.getByText("Uploading a.md to /…")).toBeTruthy();
    act(() => updateToast(id, "Uploaded to /: a.md", { alert: false }));
    expect(screen.queryByText("Uploading a.md to /…")).toBeNull();
    expect(screen.getByText("Uploaded to /: a.md")).toBeTruthy();
    act(() => void vi.advanceTimersByTime(5000));
    expect(screen.queryByText("Uploaded to /: a.md")).toBeNull();
  });

  it("runs a toast's action and dismisses it", () => {
    render(<Toasts />);
    const run = vi.fn();
    let id = 0;
    act(() => void (id = showProgressToast("Downloading a.md…")));
    act(() => updateToast(id, "Saved a.md", { alert: false, action: { label: "Show in Finder", run } }));
    fireEvent.click(screen.getByRole("button", { name: "Show in Finder" }));
    expect(run).toHaveBeenCalledOnce();
    expect(screen.queryByText("Saved a.md")).toBeNull();
  });
});

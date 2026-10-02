import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { showToast, Toasts } from "./Toast";

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
});

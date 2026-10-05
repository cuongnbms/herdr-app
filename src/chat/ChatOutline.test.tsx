import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatOutline } from "./ChatOutline";

const entries = [
  { row: 0, key: "i:0", label: "fix the header" },
  { row: 3, key: "i:5", label: "now the footer" },
];

beforeEach(() => localStorage.clear());

const rail = () => screen.getByRole("navigation", { name: "Conversation outline" });
const handle = () => screen.getByRole("separator", { name: "Resize outline" });

describe("ChatOutline", () => {
  it("marks the turn being read and jumps to the one clicked", () => {
    const onJump = vi.fn();
    render(<ChatOutline entries={entries} current={1} onJump={onJump} />);
    expect(screen.getByRole("button", { name: "now the footer" }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: "fix the header" }).getAttribute("aria-current")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "fix the header" }));
    expect(onJump).toHaveBeenCalledWith(0);
  });

  it("shows a single turn, and keeps the rail without turns so the chat doesn't shift", () => {
    const { rerender } = render(<ChatOutline entries={entries.slice(0, 1)} current={0} onJump={() => {}} />);
    expect(screen.getByRole("button", { name: "fix the header" }).getAttribute("aria-current")).toBe("true");
    rerender(<ChatOutline entries={[]} current={-1} onJump={() => {}} />);
    expect(rail().style.width).toBe("260px");
    expect(rail().querySelectorAll("button")).toHaveLength(0);
    expect(screen.getByText("Your prompts will appear here.")).toBeTruthy();
  });

  it("widens as its edge is dragged left, and remembers the width", () => {
    const { unmount } = render(<ChatOutline entries={entries} current={0} onJump={() => {}} />);
    expect(rail().style.width).toBe("260px");
    fireEvent.pointerDown(handle(), { clientX: 1000, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientX: 940, pointerId: 1 });
    expect(rail().style.width).toBe("320px");
    fireEvent.pointerUp(handle(), { clientX: 940, pointerId: 1 });
    unmount();
    render(<ChatOutline entries={entries} current={0} onJump={() => {}} />);
    expect(rail().style.width).toBe("320px");
  });

  it("stays within its range, and a double-click restores the default", () => {
    render(<ChatOutline entries={entries} current={0} onJump={() => {}} />);
    fireEvent.pointerDown(handle(), { clientX: 1000, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientX: 2000, pointerId: 1 });
    expect(rail().style.width).toBe("200px");
    fireEvent.pointerUp(handle(), { clientX: 2000, pointerId: 1 });
    fireEvent.doubleClick(handle());
    expect(rail().style.width).toBe("260px");
  });

  it("does not resize on a pointer move without a press", () => {
    render(<ChatOutline entries={entries} current={0} onJump={() => {}} />);
    fireEvent.pointerMove(handle(), { clientX: 100, pointerId: 1 });
    expect(rail().style.width).toBe("260px");
  });
});

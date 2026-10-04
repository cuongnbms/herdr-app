import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatOutline } from "./ChatOutline";

const entries = [
  { row: 0, key: "i:0", label: "fix the header" },
  { row: 3, key: "i:5", label: "now the footer" },
];

describe("ChatOutline", () => {
  it("marks the turn being read and jumps to the one clicked", () => {
    const onJump = vi.fn();
    render(<ChatOutline entries={entries} current={1} onJump={onJump} />);
    expect(screen.getByRole("button", { name: "now the footer" }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: "fix the header" }).getAttribute("aria-current")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "fix the header" }));
    expect(onJump).toHaveBeenCalledWith(0);
  });

  it("renders nothing for a single turn", () => {
    const { container } = render(<ChatOutline entries={entries.slice(0, 1)} current={0} onJump={() => {}} />);
    expect(container.innerHTML).toBe("");
  });
});

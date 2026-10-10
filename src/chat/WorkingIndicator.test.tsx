import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkingIndicator } from "./WorkingIndicator";
describe("WorkingIndicator", () => {
  it("shows while the agent is working", () => {
    render(<WorkingIndicator status="working" />);
    expect(screen.getByRole("status").textContent).toContain("Working");
  });
  it.each(["idle", "blocked", "done", "unknown"] as const)("hides when %s", (status) => {
    render(<WorkingIndicator status={status} />);
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("keeps its row while hidden, so the layout does not jump", () => {
    const { container, rerender } = render(<WorkingIndicator status="working" />);
    const row = container.querySelector(".chat-working");
    rerender(<WorkingIndicator status="idle" />);
    expect(container.querySelector(".chat-working")).toBe(row);
  });
});

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
});

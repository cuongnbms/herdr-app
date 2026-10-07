import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChangedList } from "./ChangedList";

const change = (path: string) => ({ code: " M", path }) as never;

describe("ChangedList", () => {
  it("says when only the first changes are listed", () => {
    const { rerender } = render(<ChangedList changed={{ repo: true, total: 2, changes: [change("a"), change("b")] }} onOpen={() => {}} />);
    expect(screen.getByText("CHANGED (2)")).toBeTruthy();
    rerender(<ChangedList changed={{ repo: true, total: 250, changes: [change("a"), change("b")] }} onOpen={() => {}} />);
    expect(screen.getByText("CHANGED (250) · first 2")).toBeTruthy();
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./btw", async (orig) => {
  const m = await orig<typeof import("./btw")>();
  return { ...m, stopSide: vi.fn(), closeSide: vi.fn() };
});
import { closeSide, stopSide, useBtw } from "./btw";
import { BtwCard } from "./BtwCard";
import { paneKey } from "../lib/types";

const pane = { machine_id: "devtuf", session: "default", pane_id: "w1:p1" };
const key = paneKey(pane);
const setThread = (running: boolean, error?: string) =>
  useBtw.setState({
    threads: { [key]: { path: "/p/t1.jsonl", forkId: "f1", turns: [{ q: "why?", a: "**Because**", tools: ["Read"], running, error }] } },
    mode: {},
  });

beforeEach(() => {
  vi.mocked(stopSide).mockReset();
  vi.mocked(closeSide).mockReset();
  useBtw.setState({ threads: {}, mode: {} });
});

describe("BtwCard", () => {
  it("renders nothing without a thread", () => {
    const { container } = render(<BtwCard pane={pane} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the question, tools and the markdown answer; Stop while running", () => {
    setThread(true);
    render(<BtwCard pane={pane} />);
    expect(screen.getByText(/why\?/)).toBeTruthy();
    expect(screen.getByText("⚙ Read")).toBeTruthy();
    expect(screen.getByText("Because").tagName).toBe("STRONG");
    fireEvent.click(screen.getByRole("button", { name: "Dừng" }));
    expect(stopSide).toHaveBeenCalledWith(key);
  });

  it("Hỏi tiếp turns btw mode on, Đóng closes the thread, an error shows", () => {
    setThread(false, "claude not found on this machine");
    render(<BtwCard pane={pane} />);
    expect(screen.queryByRole("button", { name: "Dừng" })).toBeNull();
    expect(screen.getByText("claude not found on this machine")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hỏi tiếp" }));
    expect(useBtw.getState().mode[key]).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Đóng" }));
    expect(closeSide).toHaveBeenCalledWith(pane);
  });
});

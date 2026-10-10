import { act, fireEvent, render, screen } from "@testing-library/react";
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

  it("renders the answer with the transcript's markdown styles", () => {
    setThread(false);
    render(<BtwCard pane={pane} />);
    expect(screen.getByText("Because").closest(".btw-a")?.classList.contains("chat-assistant")).toBe(true);
  });

  describe("scrolling", () => {
    const turn = (q: string, a = "", running = false) => ({ q, a, tools: [], running });
    const setTurns = (turns: ReturnType<typeof turn>[]) =>
      act(() => useBtw.setState({ threads: { [key]: { path: "/p/t1.jsonl", turns } }, mode: {} }));
    const card = () => document.querySelector(".btw-card") as HTMLElement;
    const size = (el: HTMLElement, scrollHeight: number, clientHeight: number) => {
      Object.defineProperty(el, "scrollHeight", { configurable: true, value: scrollHeight });
      Object.defineProperty(el, "clientHeight", { configurable: true, value: clientHeight });
    };

    it("brings a new turn into view, though the card was scrolled up", () => {
      setTurns([turn("one", "a")]);
      render(<BtwCard pane={pane} />);
      const el = card();
      size(el, 300, 100);
      el.scrollTop = 0;
      fireEvent.scroll(el);
      size(el, 400, 100);
      setTurns([turn("one", "a"), turn("two", "", true)]);
      expect(el.scrollTop).toBe(400);
      size(el, 450, 100);
      setTurns([turn("one", "a"), turn("two", "b", true)]);
      expect(el.scrollTop).toBe(450);
    });

    it("keeps a streaming answer pinned to the bottom unless scrolled up", () => {
      setTurns([turn("one", "a", true)]);
      render(<BtwCard pane={pane} />);
      const el = card();
      size(el, 500, 100);
      el.scrollTop = 400;
      fireEvent.scroll(el);
      setTurns([turn("one", "a more", true)]);
      size(el, 600, 100);
      setTurns([turn("one", "a more text", true)]);
      expect(el.scrollTop).toBe(600);
      el.scrollTop = 100; // the user scrolls up
      fireEvent.scroll(el);
      setTurns([turn("one", "a more text and more", true)]);
      expect(el.scrollTop).toBe(100);
    });
  });
});

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ herdrCall: vi.fn() }));
import { herdrCall } from "../lib/ipc";
import { PI_MODEL_POLL_MS, PI_MODEL_WAIT_MS, usePiModelPicker } from "./usePiModelPicker";

const pane = { machine_id: "devtuf", session: "default", pane_id: "w1:p1" };
const picker = `
>

→ ✓ a-model [p] · default
    b-model [p]

 Enter to select · Ctrl+S to set as default · Escape/Ctrl+C to cancel
────────────────────────
/tmp/app
`;
const prompt = "────────────────────────\n> \n────────────────────────\n/tmp/app\n";

let shown = prompt;
const reads = () => vi.mocked(herdrCall).mock.calls.filter(([, , method]) => method === "pane.read").length;
const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers();
  shown = prompt;
  vi.mocked(herdrCall)
    .mockReset()
    .mockImplementation(async (_m, _s, method) => (method === "pane.read" ? { text: shown } : {}));
});
afterEach(() => vi.useRealTimers());

describe("usePiModelPicker", () => {
  it("reads nothing until armed", async () => {
    const onDone = vi.fn();
    renderHook(() => usePiModelPicker(pane, false, onDone));
    await tick(PI_MODEL_POLL_MS * 3);
    expect(reads()).toBe(0);
  });

  it("reads the visible screen as plain text, and gives up after the wait with no picker", async () => {
    const onDone = vi.fn();
    const { result } = renderHook(() => usePiModelPicker(pane, true, onDone));
    await tick(0);
    expect(herdrCall).toHaveBeenCalledWith("devtuf", "default", "pane.read", {
      pane_id: "w1:p1",
      source: "visible",
      format: "text",
      strip_ansi: true,
    });
    await tick(PI_MODEL_WAIT_MS);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(result.current.open).toBe(false);
    const after = reads();
    await tick(PI_MODEL_POLL_MS * 3);
    expect(reads()).toBe(after);
  });

  it("is open while the picker is on screen, past the wait, and closes once it goes", async () => {
    const onDone = vi.fn();
    const { result } = renderHook(() => usePiModelPicker(pane, true, onDone));
    await tick(0);
    expect(result.current.open).toBe(false);
    shown = picker;
    await tick(PI_MODEL_POLL_MS);
    expect(result.current.open).toBe(true);
    await tick(PI_MODEL_WAIT_MS * 2);
    expect(result.current.open).toBe(true);
    expect(onDone).not.toHaveBeenCalled();
    shown = prompt;
    await tick(PI_MODEL_POLL_MS);
    expect(result.current.open).toBe(false);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("skips reads while the window is hidden", async () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    renderHook(() => usePiModelPicker(pane, true, vi.fn()));
    await tick(PI_MODEL_POLL_MS * 3);
    expect(reads()).toBe(0);
    hidden.mockRestore();
  });
});

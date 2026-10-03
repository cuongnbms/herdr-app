import { describe, expect, it, vi } from "vitest";
import { startAgent } from "./startAgent";

const busy = { code: "herdr_error", message: "agent target pane w5:pK is not an available shell" };
const params = { name: "claude", kind: "claude", pane_id: "w5:pK" };

describe("startAgent", () => {
  it("waits for a new pane's shell to reach its prompt", async () => {
    const call = vi.fn().mockRejectedValueOnce(busy).mockRejectedValueOnce(busy).mockResolvedValueOnce({ ok: true });
    await expect(startAgent(call, params, { intervalMs: 1 })).resolves.toEqual({ ok: true });
    expect(call).toHaveBeenCalledTimes(3);
    expect(call).toHaveBeenCalledWith("agent.start", params);
  });

  it("gives up with the last error once the shell stays busy", async () => {
    const call = vi.fn().mockRejectedValue(busy);
    await expect(startAgent(call, params, { intervalMs: 1, timeoutMs: 20 })).rejects.toBe(busy);
  });

  it("does not retry other errors", async () => {
    const other = { code: "herdr_error", message: "unknown agent kind" };
    const call = vi.fn().mockRejectedValue(other);
    await expect(startAgent(call, params, { intervalMs: 1 })).rejects.toBe(other);
    expect(call).toHaveBeenCalledTimes(1);
  });
});

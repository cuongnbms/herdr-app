export interface AgentStartParams {
  name: string;
  kind: string;
  pane_id: string;
}

type Call = (method: string, params: unknown) => Promise<unknown>;

// herdr's `agent_pane_busy`; its code does not survive `herdr_call`, its message does.
const isBusy = (e: unknown) => /not an available shell/.test((e as { message?: string } | null)?.message ?? "");

/**
 * `agent.start` in a just-created pane. herdr starts an agent only at an interactive shell
 * prompt, and a new pane's shell can still be loading its rc files: retry while it is busy.
 */
export async function startAgent(
  call: Call,
  params: AgentStartParams,
  { timeoutMs = 15000, intervalMs = 300 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await call("agent.start", params);
    } catch (e) {
      if (!isBusy(e) || Date.now() >= deadline) throw e;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

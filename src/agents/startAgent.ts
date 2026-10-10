export interface AgentStartParams {
  name: string;
  kind: string;
  pane_id: string;
  /** Extra command-line arguments for the agent. */
  args?: string[];
}

type Call = (method: string, params: unknown) => Promise<unknown>;

// herdr's `agent_pane_busy`; its code does not survive `herdr_call`, its message does.
const message = (e: unknown) => (e as { message?: string } | null)?.message ?? "";
const isBusy = (e: unknown) => /not an available shell/.test(message(e));
// herdr agent names are unique: a second `claude` is rejected with "agent name claude is already used".
const isNameTaken = (e: unknown) => /agent name .* is already used/.test(message(e));

/**
 * `agent.start` in a just-created pane. herdr starts an agent only at an interactive shell
 * prompt, and a new pane's shell can still be loading its rc files: retry while it is busy.
 * A name already in use moves on to `name-2`, `name-3`, ...
 */
export async function startAgent(
  call: Call,
  params: AgentStartParams,
  { timeoutMs = 15000, intervalMs = 300 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  for (let n = 1; ; ) {
    try {
      return await call("agent.start", n === 1 ? params : { ...params, name: `${params.name}-${n}` });
    } catch (e) {
      if (isNameTaken(e) && n < 100) {
        n++;
        continue;
      }
      if (!isBusy(e) || Date.now() >= deadline) throw e;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

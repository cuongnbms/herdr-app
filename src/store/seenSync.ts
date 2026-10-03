import { herdrCall } from "../lib/ipc";
import { useApp } from "./app";

type Call = (machineId: string, session: string, method: string, params: unknown) => Promise<unknown>;

/** Tells herdr about Done panes the user has looked at. herdr keeps a pane `done` until a
 *  focus marks it seen (reads and attaches do not), so each pane newly added to `doneSeen`
 *  gets a `pane.focus`, which turns it `idle` for every client. Returns the unsubscribe. */
export function syncSeenToHerdr(call: Call = herdrCall): () => void {
  return useApp.subscribe((s, prev) => {
    if (s.doneSeen === prev.doneSeen) return;
    for (const key of Object.keys(s.doneSeen)) {
      if (prev.doneSeen[key]) continue;
      // paneKey is `${machine_id}/${session}/${pane_id}`.
      const first = key.indexOf("/");
      const last = key.lastIndexOf("/");
      const machineId = key.slice(0, first);
      const session = key.slice(first + 1, last);
      const pane_id = key.slice(last + 1);
      call(machineId, session, "pane.focus", { pane_id }).catch((e: unknown) =>
        console.warn("pane.focus failed", key, e),
      );
    }
  });
}

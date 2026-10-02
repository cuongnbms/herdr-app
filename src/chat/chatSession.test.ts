import { describe, expect, it, vi } from "vitest";
import { onOpenFailure, openChat, watchMachine, type ChatDeps } from "./chatSession";

const ch = {} as never;
const loc = { agent: "claude", path: "/p", ambiguous: false, candidates: [] };
const flush = () => new Promise((r) => setTimeout(r, 0));
function setup(id: string) {
  const pane = { machine_id: "m", session: "s", pane_id: id };
  const resolvers: Array<() => void> = [];
  const log: string[] = [];
  const deps: ChatDeps = {
    chatOpen: vi.fn(() => {
      log.push("open");
      return new Promise<typeof loc>((r) => resolvers.push(() => r(loc)));
    }),
    chatClose: vi.fn(async () => {
      log.push("close");
    }),
  };
  return { pane, resolvers, log, deps };
}

describe("openChat sequencing", () => {
  it("closes only after a pending open settles", async () => {
    const t = setup("a");
    const h = openChat(t.pane, null, ch, t.deps);
    await flush();
    h.close();
    await flush();
    expect(t.deps.chatClose).not.toHaveBeenCalled();
    t.resolvers[0]();
    await flush();
    expect(t.log).toEqual(["open", "close"]);
  });
  it("A->close->A: the stale close does not kill the newer open, opens are serialised", async () => {
    const t = setup("b");
    const first = openChat(t.pane, null, ch, t.deps);
    await flush();
    first.close();
    const second = openChat(t.pane, null, ch, t.deps);
    await flush();
    expect(t.deps.chatOpen).toHaveBeenCalledTimes(1); // second waits for first
    t.resolvers[0]();
    await flush();
    expect(t.deps.chatOpen).toHaveBeenCalledTimes(2);
    t.resolvers[1]();
    await second.opened;
    await flush();
    expect(t.deps.chatClose).not.toHaveBeenCalled();
    second.close();
    await flush();
    expect(t.log).toEqual(["open", "open", "close"]);
  });
  it("cancelled before its turn never opens", async () => {
    const t = setup("c");
    const a = openChat(t.pane, null, ch, t.deps);
    const b = openChat(t.pane, null, ch, t.deps);
    b.close();
    await flush();
    t.resolvers[0]();
    await a.opened;
    await flush();
    expect(t.deps.chatOpen).toHaveBeenCalledTimes(1);
    expect(await b.opened).toBeNull();
    expect(t.deps.chatClose).toHaveBeenCalledTimes(1);
  });
  it("close after a failed open still settles", async () => {
    const t = setup("d");
    t.deps.chatOpen = vi.fn(() => Promise.reject(new Error("x")));
    const h = openChat(t.pane, null, ch, t.deps);
    await h.opened.catch(() => {});
    h.close();
    await flush();
    expect(t.deps.chatClose).toHaveBeenCalledTimes(1);
  });
});

describe("onOpenFailure", () => {
  const nf = { code: "not_found", message: "no transcript" };
  it("forgets a remembered path that is gone and locates again", () => {
    expect(onOpenFailure("/old.jsonl", nf, "connected")).toBe("retry_auto");
  });
  it("falls back to the terminal only when auto-locate finds nothing", () => {
    expect(onOpenFailure(null, nf, "connected")).toBe("fallback");
  });
  it("is just an error while the machine is not connected, or for other codes", () => {
    expect(onOpenFailure(null, nf, "disconnected")).toBe("error");
    expect(onOpenFailure("/p", nf, "error")).toBe("error");
    expect(onOpenFailure(null, { code: "io", message: "x" }, "connected")).toBe("error");
  });
});

describe("watchMachine", () => {
  it("reopens only on a down -> connected edge", () => {
    let w = watchMachine(false, "connected");
    expect(w).toEqual({ sawDown: false, reopen: false });
    w = watchMachine(w.sawDown, "disconnected");
    expect(w.reopen).toBe(false);
    w = watchMachine(w.sawDown, "authenticating");
    w = watchMachine(w.sawDown, "connected");
    expect(w).toEqual({ sawDown: false, reopen: true });
    expect(watchMachine(w.sawDown, "connected").reopen).toBe(false);
  });
});

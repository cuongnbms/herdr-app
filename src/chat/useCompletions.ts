import { useEffect, useState } from "react";
import { completeCommands, completeFiles } from "../lib/ipc";
import { paneKey } from "../lib/types";
import type { PaneRef, SlashCommand } from "../lib/types";

type Kind = "slash" | "file";
type Listing = SlashCommand[] | string[];

const TTL_MS: Record<Kind, number> = { slash: 30_000, file: 5_000 };
const cache = new Map<string, { at: number; data: Listing }>();

/** Drops every cached listing (tests). */
export function clearCompletionCache(): void {
  cache.clear();
}

/** True when `key` has no cached listing or its listing has outlived the TTL. */
const stale = (key: string, kind: Kind) => {
  const hit = cache.get(key);
  return !hit || Date.now() - hit.at >= TTL_MS[kind];
};

/** Lists a Pane's slash commands or files on its Machine, only while `kind` is set. */
export function useCompletions(
  pane: PaneRef,
  kind: Kind | null,
): { commands: SlashCommand[]; files: string[]; loading: boolean; error: boolean } {
  const key = kind ? `${paneKey(pane)}|${kind}` : null;
  const [result, setResult] = useState<{ key: string; data: Listing | null } | null>(null);

  // Stale-while-revalidate: a cached listing shows whatever its age; an old one is refetched.
  const outdated = key !== null && kind !== null && stale(key, kind);
  useEffect(() => {
    if (!key || !kind || !outdated) return;
    let live = true;
    const request = kind === "slash" ? completeCommands(pane) : completeFiles(pane);
    request.then(
      (data) => {
        cache.set(key, { at: Date.now(), data });
        if (live) setResult({ key, data });
      },
      (e) => {
        console.error("completion listing failed", e);
        if (live) setResult({ key, data: null });
      },
    );
    return () => {
      live = false;
    };
    // `pane` is identified by `key`; a new object for the same Pane must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, outdated]);

  const data = (key ? cache.get(key)?.data : undefined) ?? (result?.key === key ? result.data : null);
  const failed = key !== null && data === null && result?.key === key;
  return {
    commands: kind === "slash" ? ((data as SlashCommand[] | null) ?? []) : [],
    files: kind === "file" ? ((data as string[] | null) ?? []) : [],
    loading: key !== null && data === null && !failed,
    error: failed,
  };
}

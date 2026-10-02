import type { QuotaOutcome, QuotaProvider, QuotaWindow } from "../lib/types";

/** Providers in display order. */
export const QUOTA_PROVIDERS: QuotaProvider[] = ["claude", "codex", "opencodeGo", "grok"];

export const PROVIDER_INFO: Record<QuotaProvider, { name: string; cli: string; agent: string }> = {
  claude: { name: "Claude", cli: "claude", agent: "claude" },
  codex: { name: "Codex", cli: "codex", agent: "codex" },
  opencodeGo: { name: "OpenCode Go", cli: "opencode", agent: "opencode" },
  grok: { name: "Grok", cli: "grok", agent: "grok" },
};

export interface QuotaReport {
  windows: QuotaWindow[];
  fetchedAt: number;
}

export type QuotaEntry =
  | { kind: "loading" }
  | { kind: "notSignedIn" }
  | { kind: "ok"; report: QuotaReport }
  | { kind: "problem"; message: string; last: QuotaReport | null };

/** The entry after a fetch outcome; problems keep the last good report, except "no subscription". */
export function applying(entry: QuotaEntry, outcome: QuotaOutcome, provider: QuotaProvider): QuotaEntry {
  switch (outcome.kind) {
    case "ok":
      return { kind: "ok", report: { windows: outcome.windows, fetchedAt: outcome.fetchedAt } };
    case "notSignedIn":
      return { kind: "notSignedIn" };
    case "noSubscription":
      return { kind: "problem", message: "no Go subscription", last: null };
    case "signInExpired":
      return problem(entry, `sign-in expired — run ${PROVIDER_INFO[provider].cli}`);
    case "rateLimited":
      return problem(entry, "rate limited");
    case "failed":
      return problem(entry, outcome.reason);
  }
}

function problem(entry: QuotaEntry, message: string): QuotaEntry {
  const last = entry.kind === "ok" ? entry.report : entry.kind === "problem" ? entry.last : null;
  return { kind: "problem", message, last };
}

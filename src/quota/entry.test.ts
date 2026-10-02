import { describe, expect, it } from "vitest";
import type { QuotaWindow } from "../lib/types";
import { applying, type QuotaEntry } from "./entry";

const then = 1_789_650_000_000;
const windows: QuotaWindow[] = [{ label: "week", usedPercent: 28, resetsAt: null, durationSecs: null }];
const ok: QuotaEntry = { kind: "ok", report: { windows, fetchedAt: then } };
const last = { windows, fetchedAt: then };

describe("applying", () => {
  it("a report replaces whatever was there", () => {
    const fresh: QuotaWindow[] = [{ label: "week", usedPercent: 30, resetsAt: null, durationSecs: null }];
    const starts: QuotaEntry[] = [{ kind: "loading" }, { kind: "notSignedIn" }, ok, { kind: "problem", message: "rate limited", last: null }];
    for (const s of starts)
      expect(applying(s, { kind: "ok", windows: fresh, fetchedAt: then + 1 }, "claude")).toEqual({ kind: "ok", report: { windows: fresh, fetchedAt: then + 1 } });
  });
  it("not signed in replaces everything", () => {
    expect(applying(ok, { kind: "notSignedIn" }, "claude")).toEqual({ kind: "notSignedIn" });
  });
  it("problems keep the last report", () => {
    expect(applying(ok, { kind: "signInExpired" }, "claude")).toEqual({ kind: "problem", message: "sign-in expired — run claude", last });
    expect(applying(ok, { kind: "rateLimited", until: then }, "claude")).toEqual({ kind: "problem", message: "rate limited", last });
    expect(applying(ok, { kind: "failed", reason: "HTTP 500" }, "claude")).toEqual({ kind: "problem", message: "HTTP 500", last });
    const twice = applying(applying(ok, { kind: "failed", reason: "HTTP 500" }, "grok"), { kind: "signInExpired" }, "grok");
    expect(twice).toEqual({ kind: "problem", message: "sign-in expired — run grok", last });
  });
  it("no subscription drops the last report", () => {
    expect(applying(ok, { kind: "noSubscription" }, "opencodeGo")).toEqual({ kind: "problem", message: "no Go subscription", last: null });
  });
  it("names the CLI to run", () => {
    expect(applying({ kind: "loading" }, { kind: "signInExpired" }, "opencodeGo")).toEqual({ kind: "problem", message: "sign-in expired — run opencode", last: null });
  });
});

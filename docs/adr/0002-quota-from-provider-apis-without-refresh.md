# 0002: Read Quota from Provider APIs with the CLIs' own credentials, never refreshing them, accepting stale numbers for an unused CLI

> Status: Accepted · Date: 2026-10-03

## Context

The Agent Dashboard shows how much of each Provider's Quota is used. None of the four Providers (Claude, Codex, OpenCode Go, Grok) has a documented usage API, but each CLI stores a credential on this Mac that an undocumented usage endpoint accepts. Those credentials expire (Claude after about 8 hours, Grok after 6, Codex after 10 days); the CLIs refresh them when they run, and Claude and Grok rotate the refresh token as they do.

herdpet made and verified the same decision in its ADR 0005; this ports it.

Source: [design spec](../superpowers/specs/2026-10-03-dashboard-quota-design.md)

## Decision

The Rust core reads each CLI's stored credential read-only and calls the Provider's usage endpoint with it. It never refreshes, writes or rotates a token and never launches a CLI. An expired credential shows the last numbers dimmed and "sign-in expired — run `<cli>`".

An expired token means that CLI has not run for hours, so its Quota is not moving and the last numbers are still right. Refreshing from the app would race the CLI over a rotating refresh token and could sign the user out.

## Consequences

A Provider whose CLI has not run for a while shows "sign-in expired" until the CLI runs again, even though the account is fine. Every endpoint is undocumented and can change without notice; the parsers skip what they cannot read, and a response with nothing readable shows "unreadable response" rather than wrong numbers.

## Alternatives considered

| Alternative | Why not chosen |
|-------------|----------------|
| Refresh tokens from the app and write them back | Claude and Grok rotate refresh tokens; a refresh racing the CLI's own can invalidate the one the CLI holds. |
| Drive the CLIs (`codex app-server`, `claude` PTY `/usage`) | A process per poll and screen parsing tied to CLI releases; nothing equivalent for Grok or OpenCode. |
| Fetch from the webview | Blocked by CORS, and the Claude credential lives in the Keychain, which only the Rust core can read. |

# 0001: Reach remote Machines through the system `ssh` binary with socket forwarding, accepting a dependency on OpenSSH and stream-local forwarding

> Status: Accepted · Date: 2026-10-02

## Context

The app must browse and drive herdr Sessions on remote Machines. The upstream herdr-web-ui solves this by installing a private bridge (Bun, Node, node-pty) on each remote computer and tunnelling to it. The user's remote computers already run herdr, and their SSH setup (aliases, ssh-agent, ProxyJump, passphrase-protected keys) lives in `~/.ssh/config`.

Source: [design spec](../superpowers/specs/2026-10-02-herdr-app-design.md)

## Decision

The Rust core spawns the system `ssh` binary for every remote operation. One ControlMaster connection per Machine carries all traffic: the remote herdr Unix socket is forwarded to a local Unix socket (`-O forward -L local.sock:remote.sock`), terminals run as `ssh -tt <target> herdr terminal attach <id>`, and short commands and Transcript tails run as plain `ssh <target> <cmd>`. The first authentication of a Machine runs in a PTY the user sees, so host-key and passphrase prompts are answered by the user, never stored.

This reuses the user's existing SSH configuration unchanged and requires nothing on the remote computer except herdr itself, which the bridge approach and a pure-Rust SSH library both fail to do.

## Consequences

The app depends on OpenSSH ≥ 6.7 on the local Mac and on `AllowStreamLocalForwarding` being enabled on each remote sshd (the default). A remote whose sshd disables it cannot be used and is reported with that reason. Every Transcript read on a remote Machine is a shell command, so Transcript discovery is limited to what `ls`/`find`/`tail` can do.

## Alternatives considered

| Alternative | Why not chosen |
|-------------|----------------|
| Install a bridge on the remote (upstream approach) | Requires shipping and updating a runtime bundle on every remote; the remote already has herdr, which exposes everything needed over its socket. |
| Pure-Rust SSH client (`russh`) | Would have to reimplement `~/.ssh/config` parsing, ssh-agent, ProxyJump and known_hosts handling that OpenSSH already does correctly. |
| `herdr --machine` / `herdr machine add` | Ties the app to herdr's saved-machine list and exposes only CLI commands, not a raw socket for subscriptions or terminal streams. |

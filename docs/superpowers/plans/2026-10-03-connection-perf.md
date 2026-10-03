# Connection Perf (PR 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fewer sequential ssh round trips and login shells on connect/reconnect, no useless polling or probing, and a faster app exit, with no change in behaviour.

**Architecture:** Seven independent, small changes in the existing connect / supervise / exit paths (`src-tauri/src/machines.rs`, `transport/`) and two frontend hooks. Item D (persistent RPC socket) is dropped: herdr 0.9.1 closes the socket after one response (checked by sending two `session.snapshot` on one connection; the second got EOF).

**Tech Stack:** Rust (tokio, Tauri 2), React + vitest.

**Spec:** the approved design in `tmp/handoffs/2026-10-03-connection-perf.md` ("Decisions") plus the choices settled with the user on 2026-10-03: C merges probe + session list (not `drop_client_only`); F probes only on entry to `working`/`done`; G skips per-session `-O cancel` on exit and disconnects concurrently; H resets backoff after 30 s of watcher uptime; measurements on `devtuf`.

## Global Constraints

- No behaviour change visible to the user other than speed.
- Do not change `find_pane`'s signature or body, or `useTranscriptProbe(pane, status, locate?, retryMs?)`'s signature (PR 4 depends on both). Do not touch `update_session`/`notify`/`emit_now` or `herdr/watcher.rs`.
- Rust tests use the existing seams: `with_transport_factory`, `with_master_start`, `with_master_exit`, `with_health_check`. Never launch the app.
- Test transports that answer the probe must check for the probe first: `argv.join(" ").contains("HERDR=")` (the merged probe script also contains the text `session list`). Use the shared helper `probe_reply(sessions: &str) -> String` (Task 4) in every fake.
- Conventional Commits, one commit per task. Run `cargo fmt` only on files you edited (revert unrelated src-tauri files it touches).
- pnpm in the worktree: `export PATH="$HOME/.local/share/mise/installs/pnpm/11.18.0:$HOME/.local/share/mise/installs/node/24.14.0/bin:$PATH"`.

## Review Focus

- Stale known herdr path on reconnect (binary moved/upgraded): must fall back to discovery, not fail. Pinned by Task 3's script test.
- User override pointing at a non-existent binary: still reported as an error (`incompatible`), never silently replaced by discovery. Pinned by Task 3.
- `herdr session list` failing inside the merged probe: connect must fail with `herdr_error` exactly as before. Pinned by Task 4.
- A watcher that flaps (snapshot ok, subscription fails) must back off, while a watcher that was up for a long time and then drops must retry after 1 s. Pinned by Task 6.
- Exit must still remove forwarded local socket files. Pinned by Task 5.

---

### Task 0: Baseline measurements (temporary, not committed)

- [x] On `devtuf`, with a private ControlMaster in the scratchpad (never the app's masters in `/tmp/herdr-app-<uid>`), time: one exec RTT over the master; the current `PROBE_SCRIPT` with no path (login shell discovery); the probe with a known path; `herdr session list`; `-O cancel` vs `-O exit`. Record ssh exec count per connect from code (master check, probe, session list, optional client-only check). Save numbers to the scratchpad; they go into the final report.

### Task 1 (E): PromptPanel does not poll while hidden

**Files:** Modify `src/chat/PromptPanel.tsx` (interval ~line 261). Test `src/chat/PromptPanel.test.tsx`.

- [x] Write failing test: render `PromptPanel` with fake timers, set `document.hidden` to true (`Object.defineProperty(document, "hidden", { configurable: true, get: () => true })`), clear `herdrCall` mock after the mount read, advance `PROMPT_POLL_MS * 3`, expect no `pane.read` call; restore `hidden` to false, advance `PROMPT_POLL_MS`, expect one.
- [x] Run, see it fail. Implement: the interval tick returns early when `document.hidden` (mount/status reads unchanged, same as `useClaudeSuggestion`). Run, pass. Commit `perf(chat): skip prompt screen polling while the window is hidden`.
- Note: the "two reads per tick" from the review is by design (ANSI read only when the mirror is shown or a fallback card needs it); no change.

### Task 2 (A): Connect local and ssh concurrently at startup

**Files:** Modify `src-tauri/src/machines.rs` (add method near `connect_enabled_ssh`), `src-tauri/src/lib.rs:99-103`.

**Interfaces:** Produces `pub async fn connect_at_startup(self: &Arc<Self>)`: `tokio::join!` of `connect(LOCAL)` (error logged as `connect local: {e}`) and `connect_enabled_ssh()`. `lib.rs` calls it instead of the two sequential awaits.

- [x] Failing test `startup_does_not_wait_for_local`: registry with one enabled machine `box`; factory returns, for `local`, a transport whose `wrap` prefixes `sleep 1;` to the reply (a `sh -c` argv) and for `box` an immediate one; spawn `connect_at_startup`; after 500 ms `box` is `Connected` and `local` is not; after the join both are `Connected`.
- [x] Implement, run, commit `perf(startup): connect local and ssh machines concurrently`.

### Task 3 (B): Reuse the known herdr path on reconnect

**Files:** `src-tauri/src/transport/mod.rs` (`PROBE_SCRIPT`, `probe_argv`), `src-tauri/src/machines.rs` (`connect_inner`).

**Interfaces:** `probe_argv(herdr_override: Option<&str>, known: Option<&str>) -> Vec<String>`; argv ends `[..., "probe", override_or_empty, known_or_empty]`. Script: after `H="$1"`, add `[ -n "$H" ] || { [ -x "$2" ] && H="$2"; }` before the login-shell line. Override semantics unchanged (an invalid override still yields `incompatible`). Add `last_herdr: Option<String>` to `Machine`: set in `connect_inner` whenever `info` is set, never cleared by `teardown`/`connect_inner`, cleared by `disconnect` and by `update` (new override). `connect_inner` passes `cfg.herdr_path` and `last_herdr` to `probe_argv`.

- [x] Failing script tests in `transport/mod.rs` (run `sh -c PROBE_SCRIPT probe "" <K>` with `SHELL=/bin/false`, `HOME=<tempdir>`): K = tempdir script `herdr` (prints `herdr 0.9.9` for `--version`, `protocol: 22` for `api schema`) → `HERDR=<K>` and `PROTOCOL=22`; K = `/nonexistent/herdr` → `HERDR=` line is not `/nonexistent/herdr`; override `/nonexistent/x` with valid K → `HERDR=/nonexistent/x`.
- [x] Failing machines test `reconnect_probe_passes_the_known_path`: fake transport records probe argvs; `connect("local")` twice; the second probe's last argv element is `/h/herdr`, the first's is empty. Also `update` with a new override clears it (third probe's last element empty).
- [x] Implement, run, commit `perf(connect): reuse the known herdr path instead of a login shell on reconnect`.

### Task 4 (C): Probe and session list in one exec

**Files:** `src-tauri/src/transport/mod.rs`, `src-tauri/src/machines.rs` (`connect_inner`, tests).

**Interfaces:**
- Script tail (after `PROTOCOL=`): `echo "@@SESSIONS@@"; "$H" session list; echo "@@SESSIONS_EXIT=$?"`.
- `pub fn split_probe(stdout: &str) -> (&str, Option<(i32, &str)>)`: head before the marker line; `Some((exit, sessions_text))` when both marker lines exist.
- `parse_probe` is called on the head only. In `connect_inner`: `Some((0, s))` → `drop_client_only(t, parse_session_list(s))`; `Some((_, _))` → `AppError::new("herdr_error", format!("session list failed: {}", out.stderr.trim()))`; `None` → `self.list_sessions(id)` (old path).
- Test helper in `machines.rs` tests: `fn probe_reply(sessions: &str) -> String` = the FakeT probe lines + `@@SESSIONS@@\n{sessions}@@SESSIONS_EXIT=0\n`. Every existing fake that answered the probe returns `probe_reply(<its session list text>)` when `joined.contains("HERDR=")`.

- [x] Failing unit tests for `split_probe` (with/without marker, non-zero exit, sessions text keeps its header line) and a script test that the tail prints the marker lines using the fake `herdr` from Task 3 (make it print a session list for `session list`).
- [x] Failing machines tests: `connect_runs_one_exec_for_probe_and_sessions` (counting fake: connect("local") calls `wrap` exactly 2 times: probe + client-only check, was 3) and `failed_session_list_in_probe_fails_connect` (exit 1 → `herdr_error`, state `Error`).
- [x] Implement, update fakes, `cargo test`, commit `perf(connect): fold herdr session list into the probe exec`.

### Task 5 (G): Faster app exit

**Files:** `src-tauri/src/transport/mod.rs` (`Transport` trait), `src-tauri/src/transport/ssh.rs`, `src-tauri/src/machines.rs` (`teardown`, `disconnect`, `disconnect_all_ssh`).

**Interfaces:**
- `Transport::forget_socket(&self, s: &SessionEntry) -> AppResult<()>`, default body calls `release_socket`. `SshTransport` overrides: drop the cache entry and remove the local socket file, no ssh call.
- `teardown(id, clear, close_all, quitting: bool)`: when `quitting`, calls `forget_socket` instead of `release_socket`. All existing callers pass `false`.
- `async fn disconnect_with(&self, id: &str, quitting: bool)` holds `disconnect`'s body; `disconnect(id)` = `disconnect_with(id, false)`.
- `disconnect_all_ssh` runs `disconnect_with(id, true)` for every ssh machine concurrently (`futures::future::join_all` or spawned tasks; it takes `&self`, so `join_all`).

- [x] Failing tests: `exit_forgets_instead_of_releasing` (factory transport counts `release_socket` vs `forget_socket`; connect `box`, `disconnect_all_ssh` → forget ≥ 1, release 0; plain `disconnect` → release ≥ 1) and `exit_disconnects_machines_concurrently` (two machines, `forget_socket` sleeps 300 ms, `disconnect_all_ssh` finishes in < 500 ms).
- [x] Implement, run, commit `perf(exit): end ssh machines concurrently without per-forward cancels`.

### Task 6 (H): Supervise backoff resets only after a stable watcher

**Files:** `src-tauri/src/machines.rs` (`backoff` area, `supervise`).

**Interfaces:** `pub const STABLE_WATCH: Duration = Duration::from_secs(30);` and `fn retry_attempt(attempt: u32, up_for: Option<Duration>) -> u32` returning `0` when `up_for >= STABLE_WATCH`, else `attempt`. In `supervise`: drop `attempt = 0` on `View`; record `tokio::time::Instant` of the first `View` in this round; before sleeping, `attempt = retry_attempt(attempt, first_view.map(|t| t.elapsed()))`, then `sleep(backoff(attempt))`, then `attempt += 1`.

- [x] Failing unit test `backoff_resets_only_after_a_stable_watch`: `retry_attempt(4, None) == 4`, `retry_attempt(4, Some(5 s)) == 4`, `retry_attempt(4, Some(30 s)) == 0`, `retry_attempt(0, Some(29 s)) == 0`.
- [x] Implement, run all `cargo test`, commit `fix(watch): back off a flapping watcher instead of retrying every second`.

### Task 7 (F): Re-probe transcripts only on the transitions that matter

**Files:** `src/chat/transcriptProbe.ts`, `src/chat/transcriptProbe.test.ts`.

**Interfaces:** inside the hook, `const phase = status === "working" || status === "done" ? status : "other";` replaces `status` in the effect dependencies. Update the doc comment.

- [x] Failing test: `idle → blocked → idle → unknown` makes no call beyond the mount probe (`locate` called once with `retryMs` large, e.g. 10_000), while `→ working` adds one call and `→ done` one more.

```ts
it("looks again only when the agent starts or finishes work", async () => {
  const locate = vi.fn().mockRejectedValue(notFound);
  const { rerender } = renderHook(({ status }: { status: AgentStatus }) => useTranscriptProbe(pane, status, locate, 10_000), {
    initialProps: { status: "idle" },
  });
  await waitFor(() => expect(locate).toHaveBeenCalledTimes(1));
  for (const status of ["blocked", "idle", "unknown"] as AgentStatus[]) rerender({ status });
  await new Promise((r) => setTimeout(r, 0));
  expect(locate).toHaveBeenCalledTimes(1);
  rerender({ status: "working" });
  await waitFor(() => expect(locate).toHaveBeenCalledTimes(2));
  rerender({ status: "done" });
  await waitFor(() => expect(locate).toHaveBeenCalledTimes(3));
});
```

- [x] Implement, `pnpm test`, commit `perf(chat): probe for a transcript only when the agent starts or finishes work`.

### Task 8: Re-measure and verify

- [x] Repeat Task 0's measurements for the changed paths on `devtuf` (probe with known path, merged probe vs probe + list, exit ops).
- [x] `pnpm test`, `pnpm typecheck`, `cargo test` (in `src-tauri/`), `pnpm tauri build --debug --no-bundle` all pass.
- [x] Write a lesson-learned note only if something non-obvious turned up. Report before/after numbers and what was not exercised; ask the user to open the app once (startup with SSH machines, forced reconnect, Claude pane Terminal → Chat, quit).

## Results (2026-10-03, devtuf, private ControlMaster)

Component timings, not end-to-end: the app was not launched.

| Path | Before | After |
|---|---|---|
| Reconnect probe (zsh login shell vs known path) | ~420 ms | ~60 ms |
| Probe + `herdr session list` | 2 execs, ~60 + ~40 ms | 1 exec, ~63 ms |
| ssh execs per connect (master check excluded) | 3 (probe, list, client-only check when stopped sessions exist) | 2 |
| Exit, per forwarded session | one `-O cancel` (~23 ms), machines in series | none; machines in parallel, one `-O exit` (~23 ms) each |
| Startup | local connect, then ssh machines | all at once |

Exec RTT over the master ~36 ms; `-O check` ~23 ms. A failed probe forgets the known path (found in review: a stale but still executable herdr would otherwise be probed forever).

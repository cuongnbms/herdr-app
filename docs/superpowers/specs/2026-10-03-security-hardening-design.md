# Security hardening — design

> Date: 2026-10-03 · Status: approved design, pending spec review

PR 1 of the 2026-10-03 performance and security review. It closes six security findings. The two headline risks are XSS escalating to remote command execution (no CSP, and the webview can call `herdr_call` → `pane.send_text`) and a zero-click data leak (remote images in chat markdown and mermaid load automatically).

## Goals

- A Content Security Policy that blocks remote scripts, remote images and remote connections in the webview, in both production and `pnpm tauri dev`.
- Chat markdown images pointing to remote URLs make no network request and render as a link instead.
- `@file` completion never scans the home directory.
- Pasted images on every Machine are removed after a day.
- The runtime directory holding ssh control sockets fails closed when it cannot be secured.

## Non-goals

- Narrowing `ALLOWED_METHODS` in `machines.rs`. The CSP is what removes the XSS path to it.
- Click-to-load for remote images.
- Gating OSC 52 clipboard writes (item 6, deferred — see below).
- The four performance PRs from the same review.

## 1. CSP

`src-tauri/tauri.conf.json` `app.security.csp` changes from `null` to a policy built from this starting point:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' blob: data:; font-src 'self';
connect-src ipc: http://ipc.localhost; object-src 'none'; base-uri 'self'
```

- Grounds for each source: the frontend makes no `fetch`, WebSocket or XHR calls; images are `blob:` (chat images, composer) and `data:` (inline agent SVG marks); fonts are local woff2; external links go through the opener plugin; `index.html` has no inline script.
- `devCsp` is the same policy plus `http://localhost:1420` and `ws://localhost:1420` where Vite and HMR need them.
- Tauri adds nonces or hashes to `script-src` and `style-src` for its own assets, which makes `'unsafe-inline'` ignored there. Mermaid's SVG `<style>`, xterm's injected styles and React `style={}` all need inline styles, so `dangerousDisableAssetCspModification: ["style-src"]` is expected. The final policy is whatever survives the manual check below with zero violations.
- The policy and its reasoning are recorded in `docs/adr/0004-webview-csp.md`.

## 2. Remote images in chat

Two layers.

1. CSP `img-src` has no `http:`/`https:`, so no remote GET happens whatever produced the `<img>` (markdown or a mermaid label).
2. `mdComponents` in `src/chat/ChatItemView.tsx` gets an `img` override. A `blob:` or `data:` source renders as an image as today. Any other source renders as a link whose text is the alt text (or the URL when there is no alt), opened with `openUrl` like other chat links. No `<img>` element is created for it.

Mermaid's `initialize` call in `src/chat/MermaidBlock.tsx` adds `dompurifyConfig: { FORBID_TAGS: ['img'] }`.

## 3. `@file` completion at `$HOME`

`src-tauri/src/complete/files.rs` returns no entries when the cwd is the user's home directory, matching `complete/commands.rs:264`, which already treats `cwd == home` as having no project folders. This stops the macOS privacy (TCC) prompts and the scan of `~/Library` caches.

## 4. Pasted image cleanup

`SAVE_IMAGE_SCRIPT` in `src-tauri/src/transport/mod.rs` first removes this user's old pastes in the target directory, then writes the new one:

```
find "$d" -maxdepth 1 -type f -name 'herdr-paste-*' -user "$(id -u)" -mmin +1440 -exec rm -f {} + 2>/dev/null
```

- The sweep runs inside the existing `sh -c`, so it covers local and remote Machines with no new hook, and still cleans up after a crash.
- The TTL is 24 hours. The app cannot know when an agent has read a file; a day is long past any realistic use of a pasted image.
- The sweep is best effort: its failure never fails the save.

## 5. Runtime dir fails closed

- `secure_runtime_dir` checks the path with `symlink_metadata` before `set_permissions`, so it never changes the mode of a symlink target, then verifies owner and mode as today.
- `runtime_dir()` returns `AppResult<PathBuf>` instead of falling back to the unverified path.
- `release_socket` (`transport/ssh.rs`) and `sweep_sockets` (`machines.rs`) log and skip their work when the directory is not secure.

## 6. OSC 52 — deferred

herdr 0.9.3 does not forward OSC 52, so the unguarded clipboard write in `src/terminal/osc52.ts` is latent. No behaviour change in this PR; the comment in `osc52.ts` notes that the handler must be gated on focus or a recent keystroke before herdr starts forwarding OSC 52.

## Testing

- Item 2: vitest for the `img` override (remote → link with no `<img>`, `blob:` → `<img>`) and for the mermaid config.
- Item 3: Rust test that a home cwd yields no entries.
- Item 4: Rust test that an old `herdr-paste-*` is removed, a fresh one and a non-matching old file are kept, and the save still succeeds.
- Item 5: extend the tests at `transport/mod.rs` with a symlinked runtime path whose target mode must stay unchanged, and the fail-closed result.
- Item 1, manual: `pnpm tauri dev` with a chat holding a mermaid diagram, highlighted code and a pasted image, plus a terminal pane: zero CSP violations in the webview console, and a markdown image to `https://…` makes no request.
- `pnpm test`, `pnpm typecheck` and `cargo test` in `src-tauri/` pass.

## Delivery

Branch `security-hardening` from `dev`, one Conventional Commit per item, merged back into `dev`.

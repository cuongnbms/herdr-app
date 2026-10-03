# Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close five of the six security findings from the 2026-10-03 review (CSP, remote chat images, `@file` at `$HOME`, pasted-image cleanup, runtime-dir fail-closed) and record the sixth (OSC 52) as deferred.

**Architecture:** Frontend changes are an `img` override in the chat markdown components and a DOMPurify option for mermaid. Backend changes are local to `complete/files.rs`, the paste shell script and the runtime-dir helpers in `transport/mod.rs`. The CSP lives in `tauri.conf.json` and is tuned against the running app last, after every other change is in.

**Tech Stack:** Tauri 2, React 19 + react-markdown, mermaid 12, vitest + Testing Library, Rust (tokio, tempfile).

**Spec:** `docs/superpowers/specs/2026-10-03-security-hardening-design.md`

## Global Constraints

- Work in `.worktrees/security-hardening` on branch `security-hardening`; it merges into `dev`, never `main`.
- pnpm is not on PATH in worktrees. Run `export PATH="$HOME/.local/share/mise/installs/pnpm/11.18.0:$HOME/.local/share/mise/installs/node/24.14.0/bin:$PATH"` in each shell (check `~/.local/share/mise/installs/` if versions drifted), then `pnpm install --frozen-lockfile` once.
- One commit per task, Conventional Commits with the scope used in `git log` (`chat`, `complete`, `transport`, `terminal`, `security`).
- Rust tests run with `cargo test` from `src-tauri/`; frontend tests with `pnpm test`; types with `pnpm typecheck`.
- Insecure-state errors use `AppError` code `"io"`, matching `verify_private_dir`.
- Log lines for skipped work use `tracing::error!` with the error in the message, matching the existing `runtime dir is not secure: {e}`.
- Docker, if ever needed, runs on `devtuf` over ssh, never locally.

## Review Focus

- A markdown image whose URL has a query string (`?token=…`) must still never become an `<img>`. Pinned in Task 1's first test.
- A `$HOME` cwd reported with a trailing slash, or a home path with one, must still list nothing. Pinned in Task 2's test.
- A paste-sweep failure (unreadable dir entry, `find` lacking `-mmin`) must not fail the save: the sweep is joined to the write with `;` and silenced. Reviewed by reading the script; the existing save test must keep passing.
- A runtime path that is a symlink to a directory we own must be refused, not chmod-ed. Pinned in Task 3's test.
- The production CSP must be checked against built assets, not only under `devCsp`. Task 6 Step 6.

---

### Task 1: Remote images in chat never load

**Files:**
- Modify: `src/chat/ChatItemView.tsx:30-55` (`mdComponents`)
- Modify: `src/chat/MermaidBlock.tsx:26` (`mermaid.initialize`)
- Create: `src/chat/markdownImages.test.tsx`
- Modify: `src/chat/MermaidBlock.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: no exported API; markdown `![alt](src)` no longer creates `<img>`.

- [ ] **Step 1: Write the failing tests**

Create `src/chat/markdownImages.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const openUrl = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
vi.mock("../lib/ipc", () => ({ chatImage: vi.fn() }));
import { ChatItemView } from "./ChatItemView";

const view = (markdown: string) => render(<ChatItemView item={{ kind: "assistant_text", markdown }} />);

describe("markdown images", () => {
  it("renders a remote image as a link and never creates an <img>", () => {
    const { container } = view("See ![the chart](https://evil.example/leak.png?token=abc)");
    expect(container.querySelector("img")).toBeNull();
    const link = screen.getByRole("link", { name: "the chart" });
    expect(link.getAttribute("href")).toBe("https://evil.example/leak.png?token=abc");
    fireEvent.click(link);
    expect(openUrl).toHaveBeenCalledWith("https://evil.example/leak.png?token=abc");
  });

  it("uses the URL as the link text when there is no alt text", () => {
    view("![](https://example.com/a.png)");
    expect(screen.getByRole("link", { name: "https://example.com/a.png" })).toBeTruthy();
  });

  it("renders a relative image as its alt text only", () => {
    const { container } = view("![diagram](./out/diagram.png)");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(screen.getByText("diagram")).toBeTruthy();
  });
});
```

Append to the `describe("mermaid blocks", …)` block in `src/chat/MermaidBlock.test.tsx`:

```tsx
  it("forbids <img> in diagram labels", async () => {
    render(<ChatItemView item={{ kind: "assistant_text", markdown: md("graph TD; A-->B") }} />);
    await waitFor(() => expect(mermaid.initialize).toHaveBeenCalled());
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ dompurifyConfig: expect.objectContaining({ FORBID_TAGS: ["img"] }) }),
    );
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run src/chat/markdownImages.test.tsx src/chat/MermaidBlock.test.tsx`
Expected: FAIL — an `<img>` is found / no link role; `initialize` called without `dompurifyConfig`.

- [ ] **Step 3: Implement**

- In `ChatItemView.tsx`, move the click handler of the existing `a` override into a small local component `ExternalLink({ href, children })` (same `preventDefault` + `openUrl` for `^https?://` behaviour) and use it from both `a` and a new `img({ src, alt })` override.
- `img`: text is `alt || src || ""`. When `src` matches `/^https?:\/\//i`, render `<ExternalLink href={src}>{text}</ExternalLink>` with `className="chat-image-link"` and `title={src}`; otherwise render `<span className="chat-image-link">{text}</span>`. Never render `<img>`.
- In `MermaidBlock.tsx`, add `dompurifyConfig: { FORBID_TAGS: ["img"] }` to the `initialize` options.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run src/chat && pnpm typecheck`
Expected: all chat tests PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/chat/ChatItemView.tsx src/chat/MermaidBlock.tsx src/chat/markdownImages.test.tsx src/chat/MermaidBlock.test.tsx
git commit -m "fix(chat): render markdown images as links so remote images never load"
```

---

### Task 2: `@file` completion lists nothing at `$HOME`

**Files:**
- Modify: `src-tauri/src/complete/files.rs` (`list_files` + tests)
- Modify: `src-tauri/src/commands.rs:474-492` (`complete_files`)

**Interfaces:**
- Produces: `pub async fn list_files(t: &dyn Transport, home: &str, cwd: &str) -> AppResult<Vec<String>>` (new `home` parameter, before `cwd`).

- [ ] **Step 1: Write the failing test**

Update the two existing tests to call `list_files(&LocalTransport, "/nonexistent-home", <cwd>)`, then add:

```rust
    #[tokio::test]
    async fn the_home_folder_has_no_files() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        std::fs::create_dir_all(home.join("Library/Caches")).unwrap();
        std::fs::write(home.join("Library/Caches/x"), "").unwrap();
        std::fs::write(home.join("notes.md"), "").unwrap();
        let h = home.to_string_lossy().into_owned();
        for (home_arg, cwd) in [
            (h.clone(), h.clone()),
            (h.clone(), format!("{h}/")),
            (format!("{h}/"), h.clone()),
        ] {
            let got = list_files(&LocalTransport, &home_arg, &cwd).await.unwrap();
            assert!(got.is_empty(), "home={home_arg} cwd={cwd}: {got:?}");
        }
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test complete::files`
Expected: compile error (arity) — that is the expected failure for a signature change.

- [ ] **Step 3: Implement**

- `list_files` returns `Ok(Vec::new())` before running anything when `cwd.trim_end_matches('/') == home.trim_end_matches('/')`. Doc comment: "empty when `cwd` is missing or is the home folder, which would scan `~/Library` and trigger macOS privacy prompts". Comment the check like `commands.rs:264`.
- `complete_files` in `commands.rs` fetches `let info = mgr.info(&pane_ref.machine_id)?;` and passes `&info.home`.

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test complete::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/complete/files.rs src-tauri/src/commands.rs
git commit -m "fix(complete): skip the @file listing when the cwd is the home folder"
```

---

### Task 3: Runtime dir fails closed

**Files:**
- Modify: `src-tauri/src/transport/mod.rs:341-392` (helpers) and its tests (~`:515-532`)
- Modify: `src-tauri/src/transport/ssh.rs:3,137` (`release_socket`)
- Modify: `src-tauri/src/machines.rs:130-145` (`sweep_sockets`)

**Interfaces:**
- Produces: `fn secure_dir(dir: &std::path::Path) -> AppResult<()>` (private to `transport`); `pub fn secure_runtime_dir() -> AppResult<PathBuf>` unchanged in signature.
- Removes: `pub fn runtime_dir() -> PathBuf`. No caller may use an unverified runtime path.

- [ ] **Step 1: Write the failing tests**

In `transport/mod.rs` tests, change `socket_name_is_short` to use `runtime_dir_path()` instead of `runtime_dir()`, and add:

```rust
    #[test]
    fn secure_dir_refuses_a_symlink_without_touching_its_target() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let target = d.path().join("target");
        std::fs::create_dir(&target).unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();
        let link = d.path().join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert_eq!(secure_dir(&link).unwrap_err().code, "io");
        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755);
    }
    #[test]
    fn secure_dir_creates_a_private_dir_and_tightens_a_loose_one() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("rt");
        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        secure_dir(&p).unwrap();
        assert_eq!(mode(&p), 0o700);
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        secure_dir(&p).unwrap();
        assert_eq!(mode(&p), 0o700);
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test transport::tests::secure_dir`
Expected: compile error, `secure_dir` not found.

- [ ] **Step 3: Implement**

- `secure_dir(dir)`: `create_dir_all`, then `symlink_metadata` and refuse (code `"io"`, same message shape as `verify_private_dir`'s "not a real directory") if it is a symlink or not a directory — **before** `set_permissions` — then `set_permissions(0o700)`, then `verify_private_dir`. Reuse `verify_private_dir`'s `fail` wording rather than inventing a new message.
- `secure_runtime_dir()` becomes `let dir = runtime_dir_path(); secure_dir(&dir)?; Ok(dir)`.
- Delete `runtime_dir()`; drop it from the `use` in `ssh.rs`.
- `release_socket`: keep removing the entry from `forwards` first, then `let local = secure_runtime_dir()?.join(...)` — an insecure dir returns the error without running ssh or deleting anything.
- `sweep_sockets`: `let dir = match crate::transport::secure_runtime_dir() { Ok(d) => d, Err(e) => { tracing::error!("not sweeping sockets, runtime dir is not secure: {e}"); return; } };` then read that dir as today.

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test`
Expected: PASS, no warnings about unused `runtime_dir`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/transport/mod.rs src-tauri/src/transport/ssh.rs src-tauri/src/machines.rs
git commit -m "fix(transport): refuse a symlinked runtime dir before chmod and fail closed"
```

---

### Task 4: Pasted images expire after a day

**Files:**
- Modify: `src-tauri/src/transport/mod.rs:101-108` (`SAVE_IMAGE_SCRIPT` and its doc comment) and tests

**Interfaces:**
- Consumes/produces: `save_image_in` signature unchanged.

- [ ] **Step 1: Write the failing test**

```rust
    #[tokio::test]
    async fn saving_an_image_removes_this_users_pastes_older_than_a_day() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().to_string_lossy().into_owned();
        let aged = |name: &str, hours: u64| {
            let p = d.path().join(name);
            let f = std::fs::File::create(&p).unwrap();
            f.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(hours * 3600))
                .unwrap();
            p
        };
        let stale = aged("herdr-paste-1-1-0.png", 25);
        let fresh = aged("herdr-paste-2-1-0.png", 23);
        let other = aged("notes.png", 48);
        let path = save_image_in(&local::LocalTransport, b"img", "png", Some(&dir))
            .await
            .unwrap();
        assert!(!stale.exists(), "stale paste kept");
        assert!(fresh.exists(), "fresh paste removed");
        assert!(other.exists(), "non-paste file removed");
        assert_eq!(std::fs::read(&path).unwrap(), b"img");
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test saving_an_image_removes`
Expected: FAIL, "stale paste kept".

- [ ] **Step 3: Implement**

Insert this line into `SAVE_IMAGE_SCRIPT` right after `d=…`, before `f=…`/`umask`/`set -C`:

```
find "$d" -maxdepth 1 -type f -name 'herdr-paste-*' -user "$(id -u)" -mmin +1440 -exec rm -f {} + 2>/dev/null
```

It ends with a newline (not `&&`), so its status never decides the script's. Extend the doc comment: "First removes this user's `herdr-paste-*` files older than 24 hours there: the app cannot know when an agent has read one, and a day is past any realistic use."

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test transport::`
Expected: PASS, including `saves_image_bytes_through_stdin_as_a_private_temp_file`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/transport/mod.rs
git commit -m "fix(transport): remove pasted images older than a day when saving a new one"
```

---

### Task 5: Record OSC 52 as deferred

**Files:**
- Modify: `src/terminal/osc52.ts:20-24` (doc comment of `applyOsc52`)

- [ ] **Step 1: Extend the comment**

Add one sentence to `applyOsc52`'s doc comment: "Before herdr forwards OSC 52, gate the write on window focus or a recent keystroke: as is, any program in a Pane could overwrite the clipboard with no user action." No code change.

- [ ] **Step 2: Commit**

```bash
git add src/terminal/osc52.ts
git commit -m "docs(terminal): note the gate OSC 52 needs before herdr forwards it"
```

---

### Task 6: Content Security Policy

Manual task: the policy is tuned against the running app. It needs the user to open content in the app window.

**Files:**
- Modify: `src-tauri/tauri.conf.json` (`app.security`)
- Create: `docs/adr/0004-webview-csp.md` (follow the shape of `docs/adr/0003-chat-images-kept-from-the-tail.md`)
- Temporary, never committed: a CSP violation reporter (Step 2)

- [ ] **Step 1: Set the starting policy**

In `app.security` set:
- `"csp"`: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src ipc: http://ipc.localhost; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'`
- `"devCsp"`: the same, with `http://localhost:1420` added to `script-src`, `style-src`, `img-src`, `font-src`, and `http://localhost:1420 ws://localhost:1420` added to `connect-src`.

Rule: anything only Vite dev needs goes in `devCsp` only. Never add `'unsafe-eval'` or `http:`/`https:` to `img-src` in `csp`.

- [ ] **Step 2: Add a temporary violation reporter (do not commit)**

- `src-tauri/src/lib.rs`: a `#[tauri::command] fn csp_report(msg: String)` that does `tracing::warn!("CSP violation: {msg}")`, registered in the invoke handler.
- `src/main.tsx`: `document.addEventListener("securitypolicyviolation", (e) => void invoke("csp_report", { msg: \`${e.effectiveDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}\` }))` (import `invoke` from `@tauri-apps/api/core`).
- Find where `tracing` output lands (stdout of `pnpm tauri dev` and/or the log dir set up in `lib.rs:119`) and watch it.

- [ ] **Step 3: Run dev and have the user exercise the app**

Run `pnpm tauri dev` (via the `run` skill). Ask the user to open: a chat with a mermaid diagram, highlighted code, a pasted image, a markdown image to `https://…`, and a terminal pane (type into it). Collect every `CSP violation` line.

- [ ] **Step 4: Fix each violation and repeat Step 3 until there are none**

- Inline-style violations (mermaid `<style>` in SVG, xterm's injected styles, React `style={}`) are expected because Tauri's injected nonces/hashes make `'unsafe-inline'` ignored: add `"dangerousDisableAssetCspModification": ["style-src"]`. Leave `script-src` modification on.
- For anything else, widen the narrowest directive that fixes it and note why for the ADR. Escalate to the user before adding `'unsafe-eval'`, `'unsafe-inline'` to `script-src`, or any remote origin.

- [ ] **Step 5: Confirm the remote image makes no request**

With the markdown `https://…` image on screen, confirm no request to that host: the image renders as a link (Task 1) and no `img-src` violation for it appears, which would mean an `<img>` was created.

- [ ] **Step 6: Check the production policy**

Run `pnpm tauri build --debug` (built assets, production `csp`, devtools on), launch the produced app binary under `src-tauri/target/debug/`, and repeat Step 3 with the user. Fix and rebuild until there are no violations.

- [ ] **Step 7: Remove the reporter, write the ADR, commit**

- Revert both Step 2 edits; `git diff src-tauri/src/lib.rs src/main.tsx` must be empty.
- ADR-0004: context (XSS → `herdr_call` → `pane.send_text`; zero-click image leak), the final `csp` and `devCsp`, why each source is there, why `dangerousDisableAssetCspModification` (if used), and the rule that remote origins need a new ADR.
- Run `pnpm test && pnpm typecheck && (cd src-tauri && cargo test)`; all PASS.

```bash
git add src-tauri/tauri.conf.json docs/adr/0004-webview-csp.md
git commit -m "fix(security): add a content security policy to the webview"
```

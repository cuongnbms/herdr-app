# Slash command and @file completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the Chat lens Composer, `/` offers the Agent's Slash commands and `@` offers the files of its working directory, both read on the Pane's Machine.

**Architecture:** A new Rust module `src-tauri/src/complete/` lists commands (2 execs) and files (1 `find` exec) on the Machine through the existing `transport::exec`; two Tauri commands expose them. The frontend fetches a whole list once per trigger (cached), ranks it locally on every keystroke, and shows a popup above the textarea that takes the arrow keys, Enter, Tab and Escape while open.

**Tech Stack:** Rust (tokio, serde_json, tempfile in tests), Tauri 2, React 19 + TypeScript, vitest + Testing Library (jsdom).

**Spec:** `docs/superpowers/specs/2026-10-03-chat-composer-complete-design.md`

## Global Constraints

- Everything is read on the Pane's Machine via `crate::transport::exec(&dyn Transport, &[String])`; never `std::fs` outside tests.
- Shell scripts are passed as `sh -c <script> sh <args…>` (positional args, never string-interpolated paths), like `sh()` in `src-tauri/src/transcript/locate.rs`.
- Only a transport failure is an error (`AppError`); missing directories, unreadable files and bad JSON are skipped silently.
- `SlashCommand.source` is one of `"builtin" | "user" | "project" | "skill" | "plugin"`; `trigger` is `"$"` or absent.
- Supported Agents for Slash commands: `claude`, `pi`, `codex`. Any other Agent: no commands, no `/` popup.
- Built-in command tables and descriptions are copied verbatim from herdr-web-ui `server/commands.ts` (`BUILTINS.claude`, `BUILTINS.pi`, `BUILTINS.codex`, `PI_DESCRIPTIONS`, `DESCRIPTIONS`; fallback `Run /<name>`). A local clone is at `/private/tmp/claude-501/-Users-cuongnb-Workspace-utils-herdr-app/642fe057-8ba7-475f-80e9-cd103295011d/scratchpad/herdr-web-ui`; if missing, `git clone --depth 1 https://github.com/devswha/herdr-web-ui` into the scratchpad.
- Frontend IPC arguments are camelCase (`machineId`, `session`, `paneId`), as in `chatLocate`.
- Usage storage key: `herdr-app:slash-usage:<agent>`, value a JSON `{ [name]: count }`; every `localStorage` access in try/catch.
- Glossary: say Machine, Pane, Agent, Lens, Slash command; never host, mode.
- Commits: Conventional Commits, one per task, only the task's files.
- Verification commands: `pnpm vitest run`, `pnpm typecheck`, `cd src-tauri && cargo test`, `cd src-tauri && cargo clippy -- -D warnings`.

## Review Focus

- A file or directory name with spaces or quotes (`has space/n.md`, a home under `/Users/a b`) must survive the shell scripts — covered in Task 1 and Task 2 tests.
- A SKILL.md larger than 4096 bytes whose `description:` sits in the frontmatter must still be described — covered in Task 1.
- Typing a full command and pressing Enter before the list loaded must send, not hang — covered in Task 5 (popup takes Enter only when it has rows).
- `me@host` in prose must not open the file popup — covered in Task 3.
- A Machine that is not connected must not break the Composer: the popup shows a dimmed error, Enter still sends — covered in Task 5.

---

### Task 1: Slash command discovery on the Machine (Rust)

**Files:**
- Create: `src-tauri/src/complete/mod.rs`
- Create: `src-tauri/src/complete/commands.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod complete;`)

**Interfaces:**
- Produces (in `crate::complete::commands`):
  - `#[derive(Clone, Debug, PartialEq, Serialize)] pub struct SlashCommand { pub name: String, pub description: String, pub source: &'static str, #[serde(skip_serializing_if = "Option::is_none")] pub trigger: Option<&'static str> }`
  - `pub fn description(markdown: &str) -> String`
  - `pub fn skill_name(markdown: &str, dir: &str) -> String`
  - `pub enum RootKind { Skills, Commands, Prompts }` — `Skills`: `<dir>/*/SKILL.md` (hidden dirs skipped); `Commands`: `**/*.md` recursive, `a/b.md` named `a:b`; `Prompts`: `<dir>/*.md` direct children only (symlinks to files count).
  - `pub struct Root { pub kind: RootKind, pub dir: String, pub source: &'static str, pub prefix: String, pub trigger: Option<&'static str> }`
  - `pub fn roots(agent: &str, home: &str, cwd: Option<&str>) -> Vec<Root>` — per the spec's Scope list; no plugin roots.
  - `pub fn plugin_roots(settings_json: &str, installed_json: &str) -> Vec<Root>` — for each `enabledPlugins` entry that is `true` and has `plugins[id][0].installPath`, a `Skills` root `<installPath>/skills` then a `Commands` root `<installPath>/commands`, both source `plugin`, prefix `<id before '@'>:`.
  - `pub async fn list_commands(t: &dyn Transport, agent: &str, home: &str, cwd: Option<&str>) -> AppResult<Vec<SlashCommand>>` — builtins + scanned, sorted by `name` then `source` (plain `String` ordering).
  - Re-export from `complete/mod.rs`: `pub mod commands; pub use commands::{list_commands, SlashCommand};`

- [ ] **Step 1: Write the failing tests** at the bottom of `src-tauri/src/complete/commands.rs`

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::local::LocalTransport;
    use std::fs;
    use std::path::Path;

    fn write(p: &Path, s: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, s).unwrap();
    }
    fn find<'a>(c: &'a [SlashCommand], name: &str) -> &'a SlashCommand {
        c.iter().find(|x| x.name == name).unwrap_or_else(|| {
            panic!("no {name} in {:?}", c.iter().map(|x| &x.name).collect::<Vec<_>>())
        })
    }
    fn has(c: &[SlashCommand], name: &str) -> bool {
        c.iter().any(|x| x.name == name)
    }

    #[test]
    fn description_reads_frontmatter_then_body() {
        assert_eq!(description("---\nname: x\ndescription: \"Does X\"\n---\nbody"), "Does X");
        assert_eq!(description("---\nname: x\n---\n\n# Title line\nmore"), "# Title line");
        assert_eq!(description("plain first line\nsecond"), "plain first line");
        assert_eq!(description(&"y".repeat(300)).chars().count(), 120);
    }

    #[test]
    fn skill_name_prefers_a_valid_frontmatter_name() {
        assert_eq!(skill_name("---\nname: brainstorming\n---\n", "brain"), "brainstorming");
        assert_eq!(skill_name("---\nname: has space\n---\n", "dir"), "dir");
        assert_eq!(skill_name("no frontmatter", "dir"), "dir");
    }

    #[test]
    fn plugin_roots_only_for_enabled_plugins_with_an_install_path() {
        let settings = r#"{"enabledPlugins":{"superpowers@market":true,"off@market":false,"lost@market":true}}"#;
        let installed = r#"{"plugins":{"superpowers@market":[{"installPath":"/p/sp"}],"off@market":[{"installPath":"/p/off"}]}}"#;
        let got: Vec<(String, String)> = plugin_roots(settings, installed)
            .into_iter()
            .map(|r| (r.dir, r.prefix))
            .collect();
        assert_eq!(
            got,
            vec![
                ("/p/sp/skills".to_string(), "superpowers:".to_string()),
                ("/p/sp/commands".to_string(), "superpowers:".to_string()),
            ]
        );
        assert!(plugin_roots("not json", installed).is_empty());
    }

    #[tokio::test]
    async fn lists_claude_builtins_commands_skills_and_plugins() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home dir");
        let cwd = tmp.path().join("proj");
        let plugin = home.join("plugin");
        write(&home.join(".claude/commands/deploy.md"), "---\ndescription: Ship it\n---\n");
        write(&home.join(".claude/commands/git/sync.md"), "Sync branches\n");
        write(&cwd.join(".claude/commands/local.md"), "Project cmd\n");
        write(
            &home.join(".claude/skills/brain/SKILL.md"),
            &format!("---\nname: brainstorming\ndescription: Design first\n---\n{}", "x".repeat(8000)),
        );
        write(&home.join(".claude/skills/.hidden/SKILL.md"), "---\nname: hidden\n---\n");
        write(&plugin.join("skills/tdd/SKILL.md"), "---\ndescription: Red green\n---\n");
        write(&plugin.join("commands/review.md"), "Review it\n");
        write(&home.join(".claude/settings.json"), r#"{"enabledPlugins":{"sp@m":true}}"#);
        write(
            &home.join(".claude/plugins/installed_plugins.json"),
            &format!(r#"{{"plugins":{{"sp@m":[{{"installPath":"{}"}}]}}}}"#, plugin.display()),
        );
        let got = list_commands(
            &LocalTransport,
            "claude",
            &home.to_string_lossy(),
            Some(&cwd.to_string_lossy()),
        )
        .await
        .unwrap();
        assert_eq!(find(&got, "compact").source, "builtin");
        assert_eq!(find(&got, "deploy").description, "Ship it");
        assert_eq!(find(&got, "deploy").source, "user");
        assert_eq!(find(&got, "git:sync").description, "Sync branches");
        assert_eq!(find(&got, "local").source, "project");
        assert_eq!(find(&got, "brainstorming").source, "skill");
        assert_eq!(find(&got, "brainstorming").description, "Design first");
        assert_eq!(find(&got, "sp:tdd").source, "plugin");
        assert_eq!(find(&got, "sp:review").description, "Review it");
        assert!(!has(&got, "hidden"));
        let names: Vec<&str> = got.iter().map(|c| c.name.as_str()).collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted);
    }

    #[tokio::test]
    async fn pi_and_codex_name_their_commands_their_own_way() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let cwd = tmp.path().join("proj");
        write(&home.join(".pi/agent/prompts/fix.md"), "Fix it\n");
        write(&home.join(".pi/agent/prompts/sub/deep.md"), "Too deep\n");
        write(&home.join(".pi/agent/skills/lint/SKILL.md"), "---\ndescription: Lint\n---\n");
        write(&home.join(".agents/skills/web/SKILL.md"), "---\ndescription: Web\n---\n");
        write(&home.join(".codex/prompts/plan.md"), "Plan it\n");
        write(&home.join(".codex/skills/doc/SKILL.md"), "---\ndescription: Docs\n---\n");
        write(&cwd.join(".codex/skills/proj/SKILL.md"), "---\ndescription: Proj\n---\n");
        let h = home.to_string_lossy();
        let c = cwd.to_string_lossy();

        let pi = list_commands(&LocalTransport, "pi", &h, Some(&c)).await.unwrap();
        assert_eq!(find(&pi, "fix").source, "user");
        assert_eq!(find(&pi, "skill:lint").source, "skill");
        assert_eq!(find(&pi, "skill:web").description, "Web");
        assert!(!has(&pi, "deep") && !has(&pi, "sub:deep"));
        assert_eq!(find(&pi, "settings").description, "Open settings menu");

        let codex = list_commands(&LocalTransport, "codex", &h, Some(&c)).await.unwrap();
        assert_eq!(find(&codex, "prompts:plan").source, "user");
        assert_eq!(find(&codex, "doc").trigger, Some("$"));
        assert_eq!(find(&codex, "proj").trigger, Some("$"));
        assert_eq!(find(&codex, "diff").trigger, None);
    }

    #[tokio::test]
    async fn other_agents_have_no_commands() {
        let got = list_commands(&LocalTransport, "gemini", "/nonexistent", None).await.unwrap();
        assert!(got.is_empty());
    }
}
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd src-tauri && cargo test complete::commands`
Expected: compile errors (`list_commands`, `description`, … not found).

- [ ] **Step 3: Implement `src-tauri/src/complete/commands.rs`, `complete/mod.rs`, and `pub mod complete;` in `lib.rs`**

- `description`/`skill_name`: port of herdr-web-ui's functions; frontmatter is `^---\s*\n(…)\n---`. Use `regex` only if already a dependency (check `Cargo.toml`); otherwise plain line scanning.
- `list_commands` for claude first runs one exec that prints the two JSON files with a separator: script `cat "$1/.claude/settings.json" 2>/dev/null; printf '\036'; cat "$1/.claude/plugins/installed_plugins.json" 2>/dev/null` with arg `home`; split on `\x1e` and pass to `plugin_roots`.
- Then one exec of a scan script taking roots as args `"<kind>:<dir>"` (`kind` = `skills` | `commands` | `prompts`). For every matching file it prints a header `\036<root index>\037<path relative to dir>\n` then `head -c 4096 "$f"`. Use `"$dir"/*/SKILL.md` and `"$dir"/*.md` globs guarded by `[ -f "$f" ]`, and `find "$dir" -type f -name '*.md'` for `commands`. Skip roots whose dir is missing (`[ -d "$dir" ] || continue`), but still advance the index.
- Rust splits stdout on `\x1e`, then the header on `\x1f` and the first `\n`; names from the relative path: Skills → `skill_name(md, <first path segment>)`, Commands → path without `.md`, `/` → `:`, Prompts → file stem. Then `format!("{prefix}{name}")`.
- No exec when `roots` and plugin roots are both empty.

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd src-tauri && cargo test complete::commands`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/complete src-tauri/src/lib.rs
git commit -m "feat(complete): list an agent's slash commands on its machine"
```

### Task 2: File listing on the Machine (Rust)

**Files:**
- Create: `src-tauri/src/complete/files.rs`
- Modify: `src-tauri/src/complete/mod.rs` (add `pub mod files; pub use files::list_files;`)

**Interfaces:**
- Produces: `pub async fn list_files(t: &dyn Transport, cwd: &str) -> AppResult<Vec<String>>` — paths relative to `cwd`, `/`-separated, sorted, at most 5000; empty when `cwd` does not exist.
- Constants: `const SKIP: &[&str] = &[".git", "node_modules", ".venv", "venv", "__pycache__", "target", "dist", "build", ".next", ".worktrees"];`, `MAX_DEPTH = 6`, `MAX_FILES = 5000`.

- [ ] **Step 1: Write the failing test** at the bottom of `files.rs`

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::local::LocalTransport;

    #[tokio::test]
    async fn lists_files_relative_to_cwd_skipping_heavy_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("my repo");
        for p in [
            "README.md",
            "src/a.ts",
            "src/deep/b.ts",
            "node_modules/x/i.js",
            ".venv/lib/y.py",
            "venv/z.py",
            "target/debug/out",
            ".git/HEAD",
            "a/b/c/d/e/f.txt",
            "a/b/c/d/e/f/g.txt",
            "has space/n.md",
        ] {
            let f = root.join(p);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, "").unwrap();
        }
        let got = list_files(&LocalTransport, &root.to_string_lossy()).await.unwrap();
        assert_eq!(
            got,
            vec!["README.md", "a/b/c/d/e/f.txt", "has space/n.md", "src/a.ts", "src/deep/b.ts"]
        );
    }

    #[tokio::test]
    async fn a_missing_cwd_has_no_files() {
        let got = list_files(&LocalTransport, "/nonexistent/herdr-app").await.unwrap();
        assert!(got.is_empty());
    }
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd src-tauri && cargo test complete::files`
Expected: compile error, `list_files` not found.

- [ ] **Step 3: Implement `list_files`**

Script (arg `$1` = cwd): `cd "$1" 2>/dev/null || exit 0; find . -maxdepth 6 \( -name .git -o -name node_modules -o … \) -prune -o -type f -print | head -n 5000`, built from `SKIP`. `-maxdepth` goes first (GNU find warns otherwise). Strip the leading `./`, drop empty lines, sort.

- [ ] **Step 4: Run it to see it pass**

Run: `cd src-tauri && cargo test complete::files`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/complete
git commit -m "feat(complete): list a pane's files on its machine"
```

### Task 3: Tauri commands and IPC bindings

**Files:**
- Modify: `src-tauri/src/commands.rs` (new helper + 2 commands; `locate_pane` uses the helper)
- Modify: `src-tauri/src/lib.rs` (register `commands::complete_commands`, `commands::complete_files` in `invoke_handler`)
- Modify: `src/lib/types.ts` (add `SlashCommand`)
- Modify: `src/lib/ipc.ts` (add `completeCommands`, `completeFiles`)

**Interfaces:**
- Consumes: `crate::complete::{list_commands, list_files, SlashCommand}` (Tasks 1–2).
- Produces:
  - Rust: `async fn foreground_cwd(mgr: &MachineManager, pane_ref: &PaneRef) -> Option<String>` in `commands.rs` — the snapshot lookup currently inline in `locate_pane` (the `let fg = match mgr.session(...)` block), moved verbatim; `locate_pane` calls it.
  - Rust: `#[tauri::command] pub async fn complete_commands(mgr: Mgr<'_>, machine_id: String, session: String, pane_id: String) -> Result<Vec<SlashCommand>, AppError>` — agent = `pane.agent` (empty → `Ok(vec![])`), home = `mgr.info(&machine_id)?.home`, cwd = `foreground_cwd(..).or(pane.cwd)`.
  - Rust: `#[tauri::command] pub async fn complete_files(mgr: Mgr<'_>, machine_id: String, session: String, pane_id: String) -> Result<Vec<String>, AppError>` — no cwd → `Ok(vec![])`.
  - TS (`src/lib/types.ts`): `export interface SlashCommand { name: string; description: string; source: "builtin" | "user" | "project" | "skill" | "plugin"; trigger?: "$" }`
  - TS (`src/lib/ipc.ts`): `export const completeCommands = (p: PaneRef) => invoke<SlashCommand[]>("complete_commands", { machineId: p.machine_id, session: p.session, paneId: p.pane_id });` and `completeFiles` likewise returning `string[]`.

These are glue over tested functions and need a running manager; no new unit test.

- [ ] **Step 1: Implement the Rust helper and commands, and register them**
- [ ] **Step 2: Add the TS type and bindings**
- [ ] **Step 3: Verify**

Run: `cd src-tauri && cargo test && cargo clippy -- -D warnings` then `pnpm typecheck`
Expected: all pass, no warnings; existing `locate` tests still pass.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src/lib/types.ts src/lib/ipc.ts
git commit -m "feat(complete): expose slash commands and files over ipc"
```

### Task 4: Trigger detection and ranking (pure TS)

**Files:**
- Create: `src/chat/mentions.ts`, `src/chat/mentions.test.ts`
- Create: `src/chat/complete.ts`, `src/chat/complete.test.ts`

**Interfaces:**
- Consumes: `SlashCommand` from `src/lib/types.ts` (Task 3).
- Produces (`src/chat/mentions.ts`):
  - `export type ActiveTrigger = { kind: "slash" | "file"; prefix?: "$"; query: string; start: number; end: number }`
  - `export function activeTrigger(text: string, caret: number, options?: { skills?: boolean }): ActiveTrigger | null` — port of herdr-web-ui's, with two changes: the slash query pattern is `/^[\p{L}\p{N}_:-]*$/u` (allows `:`), and `@` must be at line start or after whitespace.
  - `export function applyCompletion(text: string, trigger: ActiveTrigger, replacement: string): { text: string; caret: number }`
- Produces (`src/chat/complete.ts`):
  - `export function rankCommands(commands: SlashCommand[], query: string, usage: Record<string, number>): SlashCommand[]` — case-insensitive tiers: 0 = name or any `:`-segment starts with query; 1 = name contains query; 2 = query is a subsequence of name; else dropped. Within a tier: usage desc, then name.
  - `export function rankFiles(paths: string[], query: string, limit = 50): string[]` — herdr-web-ui `server/files.ts` `score`, ties by `localeCompare`.
  - `export function readUsage(agent: string): Record<string, number>` and `export function recordUse(agent: string, name: string): Record<string, number>` (returns the new map).

- [ ] **Step 1: Write the failing tests**

`src/chat/mentions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { activeTrigger, applyCompletion } from "./mentions";

describe("activeTrigger", () => {
  it("opens slash at the start of any line, plugin names included", () => {
    expect(activeTrigger("/co", 3)).toEqual({ kind: "slash", query: "co", start: 0, end: 3 });
    expect(activeTrigger("hi\n/sp:br", 9)).toEqual({ kind: "slash", query: "sp:br", start: 3, end: 9 });
  });
  it("ignores a slash mid-line or once the command has an argument", () => {
    expect(activeTrigger("see /co", 7)).toBeNull();
    expect(activeTrigger("/compact now", 12)).toBeNull();
  });
  it("opens file completion after an @ that starts a word", () => {
    expect(activeTrigger("look at @src/a", 14)).toEqual({ kind: "file", query: "src/a", start: 8, end: 14 });
    expect(activeTrigger("@", 1)).toBeNull();
    expect(activeTrigger("mail me@host", 12)).toBeNull();
  });
  it("covers the token past the caret", () => {
    expect(activeTrigger("@srX more", 3)).toEqual({ kind: "file", query: "sr", start: 0, end: 4 });
  });
  it("opens $ skills only when asked", () => {
    expect(activeTrigger("use $do", 7)).toBeNull();
    expect(activeTrigger("use $do", 7, { skills: true })).toEqual({ kind: "slash", prefix: "$", query: "do", start: 4, end: 7 });
  });
});

describe("applyCompletion", () => {
  it("replaces exactly the token and puts the caret after it", () => {
    expect(applyCompletion("/co more", { kind: "slash", query: "co", start: 0, end: 3 }, "/compact ")).toEqual({
      text: "/compact  more",
      caret: 9,
    });
  });
});
```

`src/chat/complete.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import type { SlashCommand } from "../lib/types";
import { rankCommands, rankFiles, readUsage, recordUse } from "./complete";

const cmd = (name: string): SlashCommand => ({ name, description: "", source: "builtin" });
const names = (c: SlashCommand[]) => c.map((x) => x.name);
const all = ["clear", "compact", "config", "superpowers:brainstorming", "doctor"].map(cmd);

describe("rankCommands", () => {
  it("ranks prefix, then substring, then subsequence", () => {
    expect(names(rankCommands(all, "co", {}))).toEqual(["compact", "config", "doctor"]);
    expect(names(rankCommands(all, "br", {}))).toEqual(["superpowers:brainstorming"]);
    expect(names(rankCommands(all, "", {}))).toEqual(["clear", "compact", "config", "doctor", "superpowers:brainstorming"]);
    expect(names(rankCommands([cmd("Review")], "re", {}))).toEqual(["Review"]);
  });
  it("lets usage reorder within a tier only", () => {
    expect(names(rankCommands(all, "co", { config: 3, doctor: 9 }))).toEqual(["config", "compact", "doctor"]);
  });
});

describe("rankFiles", () => {
  const files = ["README.md", "src/chat/Composer.tsx", "src/chat/composer.css", "docs/compose-notes.md", "src/lib/ipc.ts"];
  it("scores substring matches, file name first", () => {
    expect(rankFiles(files, "composer")).toEqual(["src/chat/composer.css", "src/chat/Composer.tsx"]);
    expect(rankFiles(files, "ipc")).toEqual(["src/lib/ipc.ts"]);
  });
  it("caps the list", () => {
    expect(rankFiles(files, "s", 2)).toHaveLength(2);
  });
});

describe("usage", () => {
  beforeEach(() => localStorage.clear());
  it("counts picks per agent and survives bad storage", () => {
    recordUse("claude", "compact");
    expect(recordUse("claude", "compact")).toEqual({ compact: 2 });
    expect(readUsage("claude")).toEqual({ compact: 2 });
    expect(readUsage("pi")).toEqual({});
    localStorage.setItem("herdr-app:slash-usage:codex", "not json");
    expect(readUsage("codex")).toEqual({});
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run src/chat/mentions.test.ts src/chat/complete.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `src/chat/mentions.ts` and `src/chat/complete.ts`**
- [ ] **Step 4: Run them to see them pass**

Run: `pnpm vitest run src/chat/mentions.test.ts src/chat/complete.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/chat/mentions.ts src/chat/mentions.test.ts src/chat/complete.ts src/chat/complete.test.ts
git commit -m "feat(chat): detect completion triggers and rank commands and files"
```

### Task 5: Completion popup in the Composer

**Files:**
- Create: `src/chat/useCompletions.ts`
- Create: `src/chat/CompletionMenu.tsx`
- Modify: `src/chat/Composer.tsx`
- Modify: `src/chat/Composer.test.tsx`
- Modify: `src/styles.css` (after the `.composer-*` rules, ~line 746)

**Interfaces:**
- Consumes: `completeCommands`, `completeFiles` (`src/lib/ipc.ts`); `SlashCommand`, `PaneRef`, `paneKey` (`src/lib/types.ts`); `activeTrigger`, `applyCompletion`, `ActiveTrigger` (`./mentions`); `rankCommands`, `rankFiles`, `readUsage`, `recordUse` (`./complete`).
- Produces:
  - `export function useCompletions(pane: PaneRef, kind: "slash" | "file" | null): { commands: SlashCommand[]; files: string[]; loading: boolean; error: boolean }` — fetches only when `kind` is set; module-level cache keyed `${paneKey(pane)}|${kind}`, fresh for 30 000 ms (slash) / 5 000 ms (file); a failed fetch is not cached.
  - `export function clearCompletionCache(): void` (tests).
  - `export function CompletionMenu(props: { kind: "slash" | "file"; prefix: "/" | "$"; items: (SlashCommand | string)[]; active: number; loading: boolean; error: boolean; onChoose: (i: number) => void })` — `<ul role="listbox" aria-label="Slash commands" | "Files" className="composer-menu">`; each row `<li role="option" aria-selected>` with a `.hit` (`.active` when selected); slash rows show `{prefix}{name}`, a source label (`.agent` style) and a dimmed description; file rows show the directory dimmed and the file name bold. Loading row text `Loading…`; error row text `Couldn't list commands` / `Couldn't list files`. Rows choose on `onMouseDown` with `preventDefault()`. The active row is kept visible with `scrollIntoView({ block: "nearest" })` (guard: `scrollIntoView` may be undefined in jsdom).
- Composer behaviour (spec, Frontend → `Composer.tsx`): caret from `e.target.selectionStart` in `onChange` and `onSelect`; `skills: agent === "codex"`; slash triggers ignored unless `agent` is `claude`, `pi` or `codex`; rows = ranked list (files capped at 50); the popup renders when there is a trigger, it is not dismissed, and (loading, error, or rows > 0); keys are captured only when rows > 0; Escape sets dismissed, any text change clears it; active index resets to 0 when the query changes; choosing inserts `${prefix}${name} ` or `${mention(path)} ` via `applyCompletion`, sets the textarea caret in a `requestAnimationFrame`, and for slash calls `recordUse(agent, name)`.
- CSS: `.composer-box { position: relative }`; `.composer-menu` absolutely positioned at `bottom: calc(100% + 6px)`, left/right 0, `max-height` ≈ 8 rows with `overflow-y: auto`, list reset, background/border/shadow/radius matching `.palette`; reuse `.hit` / `.hit.active`.

- [ ] **Step 1: Write the failing tests** in `src/chat/Composer.test.tsx`

Replace the `vi.mock` block and imports at the top with:

```tsx
vi.mock("../lib/ipc", () => ({
  herdrCall: vi.fn().mockResolvedValue({}),
  imageSaveTemp: vi.fn(),
  completeCommands: vi.fn(),
  completeFiles: vi.fn(),
}));
import { completeCommands, completeFiles, herdrCall, imageSaveTemp } from "../lib/ipc";
import { Composer } from "./Composer";
import { clearCompletionCache } from "./useCompletions";
```

Extend the existing `beforeEach` with:

```tsx
  clearCompletionCache();
  localStorage.clear();
  vi.mocked(completeCommands).mockReset().mockResolvedValue([
    { name: "clear", description: "Clear the conversation", source: "builtin" },
    { name: "compact", description: "Compact conversation context", source: "builtin" },
  ]);
  vi.mocked(completeFiles).mockReset().mockResolvedValue(["README.md", "src/x.ts", "src/y.ts", "my docs/a.md"]);
```

Append:

```tsx
const type = (box: HTMLElement, value: string) =>
  fireEvent.change(box, { target: { value, selectionStart: value.length, selectionEnd: value.length } });

describe("Composer completion", () => {
  it("inserts the chosen slash command without sending and counts the pick", async () => {
    render(<Composer pane={pane} agent="claude" />);
    const box = screen.getByRole("textbox");
    type(box, "/c");
    await screen.findByRole("option", { name: /\/clear/ });
    expect(completeCommands).toHaveBeenCalledWith(pane);
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect((box as HTMLTextAreaElement).value).toBe("/compact ");
    expect(herdrCall).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(JSON.parse(localStorage.getItem("herdr-app:slash-usage:claude")!)).toEqual({ compact: 1 });
  });

  it("dismisses with Escape, after which Enter sends", async () => {
    render(<Composer pane={pane} agent="claude" />);
    const box = screen.getByRole("textbox");
    type(box, "/c");
    await screen.findByRole("listbox");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(herdrCall).toHaveBeenCalledWith("devtuf", "default", "agent.prompt", { target: "w1:p1", text: "/c" });
  });

  it("completes a file path with Tab", async () => {
    render(<Composer pane={pane} agent="claude" />);
    const box = screen.getByRole("textbox");
    type(box, "look at @src/x");
    await screen.findByRole("option", { name: /src\/x\.ts/ });
    expect(completeFiles).toHaveBeenCalledWith(pane);
    fireEvent.keyDown(box, { key: "Tab" });
    expect((box as HTMLTextAreaElement).value).toBe("look at @src/x.ts ");
  });

  it("quotes a path with spaces", async () => {
    render(<Composer pane={pane} agent="claude" />);
    const box = screen.getByRole("textbox");
    type(box, "@my");
    await screen.findByRole("option", { name: /my docs\/a\.md/ });
    fireEvent.keyDown(box, { key: "Enter" });
    expect((box as HTMLTextAreaElement).value).toBe('@"my docs/a.md" ');
  });

  it("chooses a row with the mouse", async () => {
    render(<Composer pane={pane} agent="claude" />);
    const box = screen.getByRole("textbox");
    type(box, "/c");
    fireEvent.mouseDown(await screen.findByRole("option", { name: /\/compact/ }));
    expect((box as HTMLTextAreaElement).value).toBe("/compact ");
  });

  it("offers no slash commands to other agents", async () => {
    render(<Composer pane={pane} agent="gemini" />);
    type(screen.getByRole("textbox"), "/c");
    await act(async () => {});
    expect(completeCommands).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("shows a failed listing in the list and still sends on Enter", async () => {
    vi.mocked(completeFiles).mockRejectedValue({ code: "not_found", message: "machine devtuf is not connected" });
    render(<Composer pane={pane} agent="claude" />);
    const box = screen.getByRole("textbox");
    type(box, "see @sr");
    expect(await screen.findByText("Couldn't list files")).toBeTruthy();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(herdrCall).toHaveBeenCalledWith("devtuf", "default", "agent.prompt", { target: "w1:p1", text: "see @sr" });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run src/chat/Composer.test.tsx`
Expected: the new tests FAIL (no `useCompletions` module / no listbox); the existing ones still pass once the module exists.

- [ ] **Step 3: Implement `useCompletions.ts`, `CompletionMenu.tsx`, the Composer changes and the CSS**
- [ ] **Step 4: Run the whole frontend suite and typecheck**

Run: `pnpm vitest run && pnpm typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/chat/useCompletions.ts src/chat/CompletionMenu.tsx src/chat/Composer.tsx src/chat/Composer.test.tsx src/styles.css
git commit -m "feat(chat): complete slash commands and @files in the composer"
```

### Task 6: Credits and full verification

**Files:**
- Modify: `THIRD_PARTY_NOTICES.md` (herdr-web-ui section, first paragraph)

- [ ] **Step 1: Credit the adapted code**

In the herdr-web-ui paragraph's list of adapted files, add: "the Composer's completion triggers in `src/chat/mentions.ts`, the file scoring in `src/chat/complete.ts`, and the built-in Slash command tables in `src-tauri/src/complete/commands.rs`".

- [ ] **Step 2: Run every check**

Run: `pnpm vitest run && pnpm typecheck && cd src-tauri && cargo test && cargo clippy -- -D warnings`
Expected: all pass, no clippy warnings.

- [ ] **Step 3: Commit**

```bash
git add THIRD_PARTY_NOTICES.md
git commit -m "docs: credit herdr-web-ui for composer completion"
```

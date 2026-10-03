# Slash command and @file completion in the Chat lens Composer

Date: 2026-10-03
Status: draft

## Purpose

Typing in the Chat lens Composer should help the way the Agent's own terminal does:
`/` at the start of a line offers the Agent's Slash commands, `@` offers the files of the
directory the Agent works in. Without it, the user has to remember command and skill names
or switch to the Terminal lens to find them.

Reference: herdr-web-ui (MIT, https://github.com/devswha/herdr-web-ui):
`server/commands.ts` (command discovery), `server/files.ts` (file scoring),
`src/lib/mentions.ts` (trigger detection), `src/components/Composer.tsx` (popup, usage
ranking). This design ports their behaviour to the Rust core and React UI, with one change:
everything is read on the Pane's Machine, local or remote, never on this Mac.

## Scope

In:

- Slash commands for three Agents:
  - **claude**: built-ins; `~/.claude/commands` (user) and `<cwd>/.claude/commands`
    (project), recursive, `a/b.md` named `a:b`; `~/.claude/skills` and
    `<cwd>/.claude/skills`; skills and commands of plugins enabled in
    `~/.claude/settings.json` (`enabledPlugins`), located through
    `~/.claude/plugins/installed_plugins.json`, named `<plugin>:<name>`.
  - **pi**: built-ins; `~/.pi/agent/prompts/*.md` (direct children only);
    `~/.pi/agent/skills` and `~/.agents/skills`, named `skill:<name>`.
  - **codex**: built-ins; `~/.codex/prompts` named `prompts:<name>`; `~/.codex/skills`
    and `<cwd>/.codex/skills`, triggered with `$` instead of `/`.
- @file completion over the Agent's working directory.
- Ranking Slash commands by how often the user picked them, per Agent, on this Mac.

Out:

- Other Agents (no `/` popup for them; `@` still works).
- `PI_CODING_AGENT_DIR` and other environment overrides on the Machine.
- pi's project-level prompts and skills (pi gates them behind a trust decision).
- Completing arguments after a Slash command.
- Honouring `.gitignore` (the user chose a fixed skip list instead).
- Directory entries in the @file list; only files.

## Working directory

The Agent's working directory is the Pane's `foreground_cwd` from the herdr snapshot when
present, else the Pane's `cwd`: the same order `locate_pane` uses for Transcripts. The
lookup is factored out of `locate_pane` into a helper both callers use.

## Backend (Rust)

New module `src-tauri/src/complete/`:

- `commands.rs`
  - Built-in tables and descriptions for claude, pi, codex, copied from herdr-web-ui.
  - `description(markdown)`: frontmatter `description:` (quotes stripped), else the first
    non-empty body line; at most 120 chars.
  - `skill_name(markdown, dir)`: frontmatter `name:` when it matches `[\p{L}\p{N}_:-]+`,
    else the directory name.
  - `roots(agent, home, cwd)`: the directories to scan, each with a kind (`skills`: one
    `SKILL.md` per subdirectory; `commands`: `*.md`, recursive or direct-children-only),
    a source (`builtin`, `user`, `project`, `skill`, `plugin`), a name prefix, and an
    optional `$` trigger.
  - `list_commands(transport, agent, home, cwd) -> Vec<SlashCommand>`:
    1. claude only: one exec that prints `~/.claude/settings.json` and
       `~/.claude/plugins/installed_plugins.json`; parsed with serde; each enabled plugin
       (`true`) with an `installPath` adds `<installPath>/skills` and
       `<installPath>/commands` roots, prefixed `<plugin>:` (the id before `@`).
    2. One exec of a `sh` script that takes the roots as arguments and, for each matching
       file, prints a record header `\x1e<root index>\x1f<relative path>\n` followed by
       the file's first 4096 bytes. Rust splits the records and builds the commands.
    3. Built-ins first, then scanned commands; sorted by name, then source.
  - Unknown Agent: empty list, no exec.
- `files.rs`
  - `list_files(transport, cwd) -> Vec<String>`: one exec of
    `find "$1" -maxdepth 6 \( -name <skip> -o … \) -prune -o -type f -print | head -n 5000`,
    returned as paths relative to `cwd`, sorted.
  - Skip list (constant): `.git`, `node_modules`, `.venv`, `venv`, `__pycache__`,
    `target`, `dist`, `build`, `.next`, `.worktrees`.

`SlashCommand`:

```rust
#[derive(Serialize)]
pub struct SlashCommand {
    pub name: String,
    pub description: String,
    pub source: &'static str, // builtin | user | project | skill | plugin
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger: Option<&'static str>, // "$" for codex skills
}
```

Tauri commands in `src-tauri/src/commands.rs`, registered in `lib.rs`:

- `complete_commands(machine_id, session, pane_id) -> Vec<SlashCommand>`
- `complete_files(machine_id, session, pane_id) -> Vec<String>`

Both find the Pane with `find_pane`, take the Agent from `pane.agent`, `home` from the
Machine's info, and the working directory as above.

Errors: a transport failure is an `AppError`. A missing directory, unreadable file or bad
JSON is skipped silently. No working directory: `complete_files` returns an empty list and
`complete_commands` scans only the home roots.

## Frontend

- `src/lib/ipc.ts`: `completeCommands(p: PaneRef)`, `completeFiles(p: PaneRef)`.
  `SlashCommand` type in `src/lib/types.ts`.
- `src/chat/mentions.ts` (from herdr-web-ui):
  - `activeTrigger(text, caret, { skills })` returns
    `{ kind: "slash" | "file", prefix?: "$", query, start, end } | null`.
    `/` triggers only at the start of a line with a query of `[\p{L}\p{N}_:-]*`;
    `@` at the start of a word (line start or after whitespace), followed by at least one
    non-space character; `$` (only with `skills`)
    at the start of a word.
  - `applyCompletion(text, trigger, replacement)` returns `{ text, caret }`.
- `src/chat/complete.ts`:
  - `rankCommands(commands, query, usage)`: keep names matching by prefix, then substring,
    then subsequence (case-insensitive); within a tier, more uses first, then name.
  - `rankFiles(paths, query, limit = 50)`: herdr-web-ui's `score`.
  - Usage: `localStorage["herdr-app:slash-usage:<agent>"]`, a `{ name: count }` object;
    every read and write in try/catch.
- `src/chat/useCompletions.ts`: fetches on the first trigger of a kind; caches per
  `machine/session/pane`, 30 s for commands, 5 s for files; exposes
  `{ items, loading, error }`.
- `src/chat/CompletionMenu.tsx`: a `role="listbox"` popup above the textarea, styled after
  the command palette (`.hit.active`, `kbd` footer). Slash rows: `/name` (or `$name`), a
  source label, a dimmed description. File rows: the path with the file name in bold. About
  8 rows visible, scrolling; the active row is scrolled into view. Shows "Loading…" while
  fetching and a dimmed "Couldn't list commands/files" on error.
- `Composer.tsx`:
  - Track the caret through `onChange` and `onSelect`; `trigger = activeTrigger(...)` with
    `skills` on for codex. Slash triggers are ignored for Agents outside claude/pi/codex.
  - The popup is open when there is a trigger, it has rows (or is loading/errored), and it
    was not dismissed. A dismissal lasts until the text changes.
  - While open, `onKeyDown` handles `ArrowUp`/`ArrowDown` (move), `Enter`/`Tab` (choose)
    and `Escape` (dismiss) before anything else; Enter does not send. Closed, keys behave
    as today.
  - Choosing inserts `/<name> ` (or `$<name> `) or `@<path> `, using the existing
    `mention()` so a path with spaces becomes `@"<path>" `; the caret lands after it.
    Choosing a Slash command increments its usage.
  - Clicking a row chooses it (`onMouseDown` with `preventDefault`, so the textarea keeps
    focus).

## Testing

Rust (`cargo test`, tempdir on the local transport, as in `locate.rs`):

- frontmatter with and without `description:`; quoted values; body fallback; truncation;
- a skill whose `name:` differs from its directory;
- nested commands named `a:b`; pi prompts read direct children only;
- enabled versus disabled plugins; a plugin without `installPath`;
- pi `skill:` and codex `prompts:` prefixes, codex `$` trigger;
- unknown Agent returns no commands;
- `find` skips `node_modules` and `.venv`, respects depth, returns relative paths.

Vitest:

- `mentions.test.ts`: `/` at the start of line 2; `/` mid-sentence does not trigger;
  `@` after text; `$` only with `skills`; `applyCompletion` replaces the whole token.
- `complete.test.ts`: tier order; usage reorders within a tier; file scoring.
- `Composer.test.tsx` (mocked `../lib/ipc`): `/co` shows `compact`; ArrowDown then Enter
  inserts without sending; Escape dismisses; `@src` lists files and Tab inserts
  `@src/x.ts `; Enter with the popup closed still sends.

## Credits

Add `mentions.ts`, the file `score`, and the built-in command tables and descriptions to
the herdr-web-ui section of `THIRD_PARTY_NOTICES.md`.

# herdr-app

A desktop client for [herdr](https://github.com/herdrdev/herdr) that browses and drives agent panes on the local computer and on remote computers.

## Language

**Machine**:
A computer where herdr runs: either `local` or a remote one reached by an SSH target (an alias from `~/.ssh/config` or `user@host`).
_Avoid_: host, PC, server, remote

**Session**:
A named persistent herdr session on a Machine; it owns exactly one herdr socket and is either running or stopped.
_Avoid_: server, instance

**Workspace**:
A group of Tabs inside a Session. What the user calls a "space".
_Avoid_: space, project

**Workspace folder**:
The folder the app remembers for a Workspace; Agents started from the app's UI run in a new Tab there. herdr itself does not know it.
_Avoid_: project dir, workspace cwd

**Tab**:
A layout of Panes inside a Workspace.

**Pane**:
One cell of a Tab's layout, identified by `pane_id`; the unit the user selects and views.

**Terminal**:
The live terminal stream behind a Pane, identified by `terminal_id`; the thing that gets attached.
_Avoid_: pty, shell

**Attach**:
An exclusive connection to a Terminal's stream; herdr allows only one at a time per Terminal.

**Agent**:
A coding agent (Claude Code, pi, ...) that herdr detects running in a Pane, with an agent status of `working`, `blocked`, `done`, `idle` or `unknown`.

**Lens**:
A way of viewing a Pane: the **Terminal lens** (the raw attached terminal) or the **Chat lens** (the Agent's Transcript as a conversation).
_Avoid_: mode, view

**Transcript**:
The Agent's own conversation file (`.jsonl`) that the Chat lens reads.
_Avoid_: history, log

## Relationships

- A **Machine** has zero or more **Sessions**
- A running **Session** has one or more **Workspaces**; a **Workspace** has one or more **Tabs**; a **Tab** has one or more **Panes**
- Each **Pane** has exactly one **Terminal**
- A **Pane** has at most one **Agent**; an **Agent** has at most one **Transcript** the app can find
- A **Terminal** has at most one **Attach** at a time

## Example dialogue

> **Dev:** "When the user clicks a **Pane** on devtuf, do we **Attach** right away?"
> **Domain expert:** "Only in the **Terminal lens**. If the **Agent** is Claude Code and we find its **Transcript**, the **Chat lens** opens and nothing is attached."

## Flagged ambiguities

- "space" (user's word) resolved: it is herdr's **Workspace**.
- "session" means a herdr named **Session**, never an agent's conversation; that is a **Transcript**.

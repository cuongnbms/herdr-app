import { describe, expect, it } from "vitest";
import { BookIcon, BotIcon, FilePenIcon, FileSearchIcon, GlobeIcon, ListChecksIcon, TargetIcon, TerminalIcon, WrenchIcon } from "../ui/icons";
import { toolIcon } from "./toolIcon";

describe("toolIcon", () => {
  it.each([
    ["Skill", BookIcon],
    ["Bash", TerminalIcon],
    ["run_command", TerminalIcon],
    ["Read", FileSearchIcon],
    ["Glob", FileSearchIcon],
    ["Grep", FileSearchIcon],
    ["Edit", FilePenIcon],
    ["MultiEdit", FilePenIcon],
    ["Write", FilePenIcon],
    ["Task", BotIcon],
    ["Agent", BotIcon],
    ["WebFetch", GlobeIcon],
    ["WebSearch", GlobeIcon],
    ["TodoWrite", ListChecksIcon],
    ["update_goal", TargetIcon],
    ["mcp__notion__search", WrenchIcon],
  ])("%s", (name, icon) => {
    expect(toolIcon(name)).toBe(icon);
  });
});

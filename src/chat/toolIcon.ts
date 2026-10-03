import type { JSX, SVGProps } from "react";
import {
  BookIcon,
  BotIcon,
  FilePenIcon,
  FileSearchIcon,
  GlobeIcon,
  ListChecksIcon,
  TargetIcon,
  TerminalIcon,
  WrenchIcon,
} from "../ui/icons";

/** The icon on a tool-call row, guessed from the tool's name; a wrench when nothing fits. */
export function toolIcon(name: string): (p: SVGProps<SVGSVGElement>) => JSX.Element {
  const n = name.toLowerCase();
  if (n === "skill") return BookIcon;
  if (n.includes("bash") || n.includes("command")) return TerminalIcon;
  if (["read", "glob", "grep"].some((k) => n.includes(k))) return FileSearchIcon;
  // Before edit/write: TodoWrite is a checklist, not a file edit.
  if (n.includes("todo")) return ListChecksIcon;
  if (n.includes("edit") || n.includes("write")) return FilePenIcon;
  if (n.includes("task") || n.includes("agent")) return BotIcon;
  if (n.includes("web")) return GlobeIcon;
  if (n.endsWith("_goal")) return TargetIcon;
  return WrenchIcon;
}

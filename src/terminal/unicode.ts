import { Unicode11Addon } from "@xterm/addon-unicode11";
import type { Terminal } from "@xterm/xterm";

/**
 * Switches `term` to Unicode 11 cell widths, which match what modern TUIs (Claude Code) assume
 * for emoji, CJK and symbols; the default v6 table misaligns their redraws.
 * Needs `allowProposedApi: true`.
 */
export function applyUnicode11(term: Terminal): void {
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
}

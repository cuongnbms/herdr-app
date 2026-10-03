// Adapted from herdr-web-ui's server/prompt.ts (MIT): see THIRD_PARTY_NOTICES.md.

const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const OSC_RE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const SOLID_RULE_RE = /^[─━]{8,}$/;

/** Claude's new-session tip in the empty input (`Try "how does <filepath> work?"`), not a suggestion. */
const CLAUDE_TIP_RE = /^Try "/;

/**
 * Whether each character of an ANSI line is drawn dim (SGR 2) and inverse (SGR 7), as
 * [text, dim, inverse] runs. Only SGR sequences change the state; 38/48 colors are skipped whole,
 * so the 2 of `38;2;r;g;b` is a color mode, not dim. Other escapes are dropped.
 */
function sgrRuns(line: string): [string, boolean, boolean][] {
  const runs: [string, boolean, boolean][] = [];
  let dim = false;
  let inverse = false;
  let offset = 0;
  const escape = /\u001b(?:\[([0-?]*)[ -/]*([@-~])|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
  for (const match of line.matchAll(escape)) {
    if (match.index > offset) runs.push([line.slice(offset, match.index), dim, inverse]);
    offset = match.index + match[0].length;
    if (match[2] !== "m") continue;
    const codes = (match[1] || "0").split(";").map((code) => Number(code || 0));
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 38 || code === 48 || code === 58) i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0;
      else if (code === 0) {
        dim = false;
        inverse = false;
      } else if (code === 22) dim = false;
      else if (code === 2) dim = true;
      else if (code === 27) inverse = false;
      else if (code === 7) inverse = true;
    }
  }
  if (offset < line.length) runs.push([line.slice(offset), dim, inverse]);
  return runs;
}

/**
 * The prompt Claude Code suggests next, grey in its empty input box: the `❯` line between the
 * screen's last two rules (the live input box, not an earlier one above a bash-mode input), all
 * of it dim but for Claude's own drawn cursor on its first character. None while anything is
 * typed there (typed text is not dim), for the new-session tip, or for an input box of more than
 * one line.
 */
export function parseClaudeSuggestion(ansi: string): string | null {
  const lines = ansi.split("\n").map((line) => line.replace(/\r$/, ""));
  const plain = lines.map((line) => line.replace(ANSI_RE, "").replace(OSC_RE, ""));
  let index = plain.length - 1;
  while (index >= 0 && !SOLID_RULE_RE.test(plain[index].trim())) index--;
  index--;
  if (index < 1 || !/^❯[\s ]/.test(plain[index]) || !SOLID_RULE_RE.test(plain[index - 1].trim())) return null;
  let text = "";
  let seenPrompt = false;
  let cursor = false;
  const runs = sgrRuns(lines[index]);
  for (const [run, dim, inverse] of runs) {
    for (const ch of run) {
      if (!seenPrompt) {
        if (ch === "❯") seenPrompt = true;
        continue;
      }
      const blank = ch.trim() === "" || ch === " ";
      // the cursor Claude draws itself sits inverse on the first grey character
      if (!dim && !blank && !(inverse && text.trim() === "" && !cursor)) return null;
      if (!dim && !blank) cursor = true;
      text += ch;
    }
  }
  // a cursor over typed text has nothing grey after it
  if (cursor && !runs.some(([run, dim]) => dim && run.trim() !== "")) return null;
  const suggestion = text.replace(/ /g, " ").trim();
  return suggestion === "" || CLAUDE_TIP_RE.test(suggestion) ? null : suggestion;
}

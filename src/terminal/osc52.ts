import type { Terminal } from "@xterm/xterm";

/**
 * The text of an OSC 52 clipboard write (`<targets>;<base64>`), or null for a read (`?`) or a
 * malformed payload. Reads are never answered, so a remote program cannot pull the clipboard.
 */
export function osc52Text(data: string): string | null {
  const sep = data.indexOf(";");
  if (sep < 0) return null;
  const payload = data.slice(sep + 1);
  if (payload === "?") return null;
  try {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Copies what programs write with OSC 52, the clipboard path Claude Code and others take over
 * ssh, where they cannot reach pbcopy. herdr 0.9.3 does not forward OSC 52 to direct attach
 * clients yet, so this only takes effect once it does. Before herdr forwards OSC 52, gate the
 * write on window focus or a recent keystroke: as is, any program in a Pane could overwrite the
 * clipboard with no user action.
 */
export function applyOsc52(term: Terminal, write: (text: string) => void): void {
  term.parser.registerOscHandler(52, (data) => {
    const text = osc52Text(data);
    if (text !== null) write(text);
    return true;
  });
}

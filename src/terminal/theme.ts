import type { ITheme } from "@xterm/xterm";

/** xterm colors; `background` matches `--surface-term` in styles.css. */
export const TERM_THEME: ITheme = {
  background: "#111214",
  foreground: "#e6e7eb",
  cursor: "#e6e7eb",
  cursorAccent: "#111214",
  selectionBackground: "rgba(124, 140, 255, 0.32)",
  black: "#1c1d21",
  red: "#f07178",
  green: "#9ece6a",
  yellow: "#e8b866",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  white: "#c8cbd4",
  brightBlack: "#5c606c",
  brightRed: "#ff8b92",
  brightGreen: "#b5e08a",
  brightYellow: "#f5cd85",
  brightBlue: "#9cbcff",
  brightMagenta: "#cdb4ff",
  brightCyan: "#a3e0ff",
  brightWhite: "#f2f3f6",
};

export const TERM_FONT = '"JetBrains Mono", Menlo, monospace';

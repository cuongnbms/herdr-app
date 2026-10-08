import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  defaultHighlightStyle,
  LanguageDescription,
  type LanguageSupport,
  syntaxHighlighting,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import type { FileContent } from "../lib/types";

/** FileEditor fills this once the file's language has loaded. */
export const languageSlot = new Compartment();

/** The view-side extensions; they are facets, so they work on a state without a view. */
export function editorExtensions(): Extension {
  return [
    lineNumbers(),
    bracketMatching(),
    highlightActiveLine(),
    search({ top: true }),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  ];
}

/** The only place an `EditorState` is made. Its line separator is CRLF iff the text has one. */
export function createEditorState(text: string): EditorState {
  return EditorState.create({
    doc: text,
    extensions: [
      text.includes("\r\n") ? EditorState.lineSeparator.of("\r\n") : [],
      history(),
      languageSlot.of([]),
      editorExtensions(),
    ],
  });
}

/** True when the editor gives back exactly `text`: LF or CRLF throughout, no lone CR, no mix. */
export function roundTrips(text: string): boolean {
  const state = createEditorState(text);
  if (state.sliceDoc() !== text) return false;
  // With a CRLF separator a bare LF stays inside a line and would still round-trip, yet it is a mix.
  for (let n = 1; n <= state.doc.lines; n++) if (/[\r\n]/.test(state.doc.line(n).text)) return false;
  return true;
}

export function canEdit(c: FileContent): boolean {
  return c.editable && c.cksum !== null && c.text !== null && roundTrips(c.text);
}

export async function languageFor(rel: string): Promise<LanguageSupport | null> {
  const description = LanguageDescription.matchFilename(languages, rel.slice(rel.lastIndexOf("/") + 1));
  return description ? description.load() : null;
}

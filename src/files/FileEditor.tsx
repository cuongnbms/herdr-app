import type { LanguageSupport } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { useDrafts } from "./drafts";
import { languageFor, languageSlot } from "./editorSetup";

const isEmpty = (v: EditorView) => {
  const ext = languageSlot.get(v.state);
  return Array.isArray(ext) && ext.length === 0;
};

/** One CodeMirror view over the Draft stored under `draftKey`; the store holds the state, the view shows it. */
export function FileEditor({ draftKey }: { draftKey: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const draft = useDrafts.getState().drafts[draftKey];
    if (!host.current || !draft) return;
    const rel = draft.rel;
    let alive = true;
    // undefined = not asked yet; null = the file has no language. Kept per mount so a refill is synchronous.
    let support: LanguageSupport | null | undefined;

    const view = new EditorView({
      state: draft.state,
      parent: host.current,
      dispatchTransactions(trs, v) {
        v.update(trs);
        useDrafts.getState().update(draftKey, v.state);
      },
    });

    // `open` and `rebase` build states with an empty language slot; this puts the language back.
    const fillLanguage = () => {
      if (!alive || !isEmpty(view)) return;
      if (support) view.dispatch({ effects: languageSlot.reconfigure(support) });
      else if (support === undefined)
        void languageFor(rel).then(
          (s) => {
            support = s;
            fillLanguage();
          },
          () => {
            support = null;
          },
        );
    };

    const unsubscribe = useDrafts.subscribe((s) => {
      const next = s.drafts[draftKey]?.state;
      if (!next || next === view.state) return;
      view.setState(next);
      fillLanguage();
    });

    view.focus();
    fillLanguage();
    return () => {
      alive = false;
      unsubscribe();
      view.destroy();
    };
  }, [draftKey]);

  return <div className="files-editor" ref={host} />;
}

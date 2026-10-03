// Each pane's unsent Composer text, kept outside the Composer: it unmounts on a pane switch,
// a lens switch, and while the agent is blocked.
const draftKey = (paneKey: string) => `herdr-app:draft:${paneKey}`;

export function readDraft(paneKey: string): string {
  try {
    return localStorage.getItem(draftKey(paneKey)) ?? "";
  } catch {
    return "";
  }
}

export function writeDraft(paneKey: string, text: string) {
  try {
    if (text) localStorage.setItem(draftKey(paneKey), text);
    else localStorage.removeItem(draftKey(paneKey));
  } catch {
    /* storage unavailable: the draft lives only while the Composer does */
  }
}

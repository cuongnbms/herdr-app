/**
 * xterm's custom key handler. Cmd chords go to the app. EVKey/OpenKey/Unikey replace typed text
 * with synthetic keys whose `key` holds several characters (e.g. "ước") while `charCode` holds only
 * the first; xterm would send `charCode` and drop the rest, so the whole `key` is sent here instead.
 */
export function createKeyHandler(send: (text: string) => void) {
  return (e: KeyboardEvent): boolean => {
    if (e.metaKey) return false;
    if (
      e.type === "keypress" &&
      !e.ctrlKey &&
      !e.altKey &&
      [...e.key].length > 1 &&
      e.key.codePointAt(0) === e.charCode
    ) {
      // Keep the browser from inserting it too, which xterm would echo as an input event.
      e.preventDefault();
      send(e.key);
      return false;
    }
    return true;
  };
}

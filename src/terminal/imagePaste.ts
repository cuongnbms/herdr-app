/** Clipboard image types a pasted image may have, with the extension it is saved under. */
export const IMAGE_EXTS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * A capture-phase paste listener for a terminal. xterm pastes only `text/plain`, so a
 * screenshot pastes nothing, and the agent's own Ctrl+V reads the clipboard of the Machine it
 * runs on, not this Mac's. Instead each image is saved on the Machine and its path pasted,
 * which Claude Code, Codex and Gemini turn into an image attachment. Text pastes go to xterm.
 */
export function createImagePaste(
  save: (bytes: Uint8Array, ext: string) => Promise<string>,
  paste: (text: string) => void,
  fail: (message: string) => void,
) {
  return (e: ClipboardEvent) => {
    const data = e.clipboardData;
    if (!data || data.getData("text/plain")) return;
    const files = Array.from(data.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const bad = files.find((f) => !IMAGE_EXTS[f.type]);
    if (bad) return fail(`Image paste failed: ${bad.type} is not supported`);
    void Promise.all(files.map(async (f) => save(new Uint8Array(await f.arrayBuffer()), IMAGE_EXTS[f.type]))).then(
      (paths) => paste(paths.join(" ")),
      (err) => fail(`Image paste failed: ${(err as { message?: string })?.message ?? String(err)}`),
    );
  };
}

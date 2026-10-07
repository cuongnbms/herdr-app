import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { filesDownload, filesUpload } from "../lib/ipc";
import { showProgressToast, showToast, updateToast } from "../ui/Toast";

const basename = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

/** How a folder reads in messages: the root is `/`, others end with `/`. */
const where = (dir: string) => (dir ? `${dir}/` : "/");

const errorMessage = (e: unknown): string =>
  typeof e === "object" && e !== null && "message" in e ? String((e as { message: unknown }).message) : String(e);

/** Upload local paths into `destRel` ("" is the root) on the Machine, reporting through a toast. */
export async function startUpload(machineId: string, root: string, destRel: string, sources: string[]): Promise<boolean> {
  if (!sources.length) return false;
  const what = sources.length === 1 ? basename(sources[0]) : `${sources.length} items`;
  const id = showProgressToast(`Uploading ${what} to ${where(destRel)}…`);
  try {
    const names = await filesUpload(machineId, root, destRel, sources);
    updateToast(id, `Uploaded to ${where(destRel)}: ${names.join(", ")}`, { alert: false });
    return true;
  } catch (e) {
    updateToast(id, `Upload failed: ${errorMessage(e)}`);
    return false;
  }
}

/** Download a file or folder into ~/Downloads, offering to reveal it in Finder. */
export async function startDownload(machineId: string, root: string, rel: string): Promise<void> {
  const id = showProgressToast(`Downloading ${basename(rel)}…`);
  try {
    const saved = await filesDownload(machineId, root, rel);
    updateToast(id, `Saved ${basename(saved)}`, {
      alert: false,
      action: {
        label: "Show in Finder",
        run: () => {
          revealItemInDir(saved).catch((e) => showToast(`Cannot show in Finder: ${errorMessage(e)}`));
        },
      },
    });
  } catch (e) {
    updateToast(id, `Download failed: ${errorMessage(e)}`);
  }
}

import { useApp } from "../store/app";
import { closingKeys, type CloseScope } from "../store/openItems";
import { isDirty, useDrafts } from "./drafts";
import { saveDraft } from "./save";
import { askUnsaved } from "./unsaved";

const basename = (rel: string): string => rel.slice(rel.lastIndexOf("/") + 1);

/** Resolves true when it is fine to lose the Drafts of `keys` (they are dropped then); false keeps every Draft. */
export async function settleDrafts(keys: string[]): Promise<boolean> {
  const drop = () => keys.forEach((k) => useDrafts.getState().drop(k));
  const dirty = keys.filter(isDirty);
  if (dirty.length === 0) {
    drop();
    return true;
  }
  const names = dirty.map((k) => basename(useDrafts.getState().drafts[k].rel));
  const choice = await askUnsaved(names);
  if (choice === "cancel") return false;
  if (choice === "save") {
    for (const k of dirty) if (!(await saveDraft(k, { force: false }))) return false;
  }
  drop();
  return true;
}

/** `closeItems`, but only once the Drafts of the items it would close are settled. */
export async function closeItemsGuarded(key: string, scope: "one" | CloseScope): Promise<void> {
  const keys = closingKeys(useApp.getState().openItems, scope, key);
  if (await settleDrafts(keys)) useApp.getState().closeItems(key, scope);
}

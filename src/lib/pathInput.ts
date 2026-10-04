/** Folder being listed and the partial name typed after it; null unless the path starts with `/` or `~/`. */
export function splitDirPrefix(path: string): { dir: string; prefix: string } | null {
  if (!path.startsWith("/") && !path.startsWith("~/")) return null;
  const slash = path.lastIndexOf("/");
  return { dir: path.slice(0, slash) || "/", prefix: path.slice(slash + 1) };
}

/** Paths of the folders in `dir` whose name starts with `prefix` (any case); dotfolders only when typed. */
export function dirSuggestions(names: string[], dir: string, prefix: string): string[] {
  const lower = prefix.toLowerCase();
  const base = dir === "/" ? "" : dir;
  return names
    .filter((n) => n.toLowerCase().startsWith(lower) && (prefix.startsWith(".") || !n.startsWith(".")))
    .slice(0, 50)
    .map((n) => `${base}/${n}`);
}

/** GitHub-style heading slug: lowercase, punctuation dropped except `-` and `_`, spaces to `-`. */
export function slugify(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
}

/** A slugger that de-duplicates repeats within one document as `-1`, `-2`, … */
export function makeSlugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text) => {
    const base = slugify(text);
    const n = seen.get(base);
    if (n === undefined) {
      seen.set(base, 0);
      return base;
    }
    seen.set(base, n + 1);
    return `${base}-${n + 1}`;
  };
}

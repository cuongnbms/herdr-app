export type Link =
  | { kind: "file"; rel: string; hash: string | null }
  | { kind: "external"; url: string }
  | { kind: "anchor"; hash: string };

/** A link's `#fragment` percent-decoded; kept as written when it is not valid encoding. */
function decodeHash(hash: string): string {
  try {
    return decodeURIComponent(hash);
  } catch {
    return hash;
  }
}

/** The first line of a GitHub-style `L12` or `L12-L20` fragment, if it is one. */
export function lineOfHash(hash: string | null): number | null {
  const m = hash ? /^L(\d+)(?:-L?\d+)?$/.exec(hash) : null;
  return m ? Number(m[1]) : null;
}

/** Classify a markdown link found in `fromRel`; a file link is resolved against the workspace root. */
export function resolveLink(fromRel: string, href: string): Link | null {
  if (/^(https?:|mailto:)/i.test(href)) return { kind: "external", url: href };
  if (href.startsWith("#")) return href.length > 1 ? { kind: "anchor", hash: decodeHash(href.slice(1)) } : null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return null;

  const hashAt = href.indexOf("#");
  const hash = hashAt >= 0 && hashAt < href.length - 1 ? decodeHash(href.slice(hashAt + 1)) : null;
  const path = (hashAt >= 0 ? href.slice(0, hashAt) : href).split("?")[0];
  if (path === "") return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }

  const parts = decoded.startsWith("/") ? [] : fromRel.split("/").slice(0, -1);
  for (const seg of decoded.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  if (parts.length === 0) return null;
  return { kind: "file", rel: parts.join("/"), hash };
}

import { useEffect, useState } from "react";
import { CheckIcon, CopyIcon } from "../ui/icons";

/** Copies the text and says so for a moment. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className="chat-copy"
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      onClick={() =>
        // Through a promise, so a webview without the Clipboard API fails here, not in the handler.
        Promise.resolve()
          .then(() => navigator.clipboard.writeText(text))
          .then(
          () => setCopied(true),
          (e) => console.error("copy failed", e),
        )
      }
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

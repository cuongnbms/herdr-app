import { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import { applyOsc52, osc52Text } from "./osc52";

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

describe("osc52Text", () => {
  it("decodes the base64 payload as UTF-8", () => {
    expect(osc52Text(`c;${b64("hello")}`)).toBe("hello");
    expect(osc52Text(`;${b64("sửa lỗi ✓")}`)).toBe("sửa lỗi ✓");
    expect(osc52Text(`pc;${b64("x")}`)).toBe("x");
  });

  it("ignores clipboard reads and malformed payloads", () => {
    expect(osc52Text("c;?")).toBeNull();
    expect(osc52Text("c;not base64!")).toBeNull();
    expect(osc52Text("no-separator")).toBeNull();
  });
});

describe("applyOsc52", () => {
  it("writes what the application copies to the clipboard", async () => {
    const write = vi.fn();
    const term = new Terminal({ allowProposedApi: true });
    applyOsc52(term, write);
    await new Promise<void>((r) => term.write(`\x1b]52;c;${b64("copied on devtuf")}\x07`, r));
    expect(write).toHaveBeenCalledWith("copied on devtuf");
    term.dispose();
  });
});

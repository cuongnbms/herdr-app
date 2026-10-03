import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { applyUnicode11 } from "./unicode";

describe("applyUnicode11", () => {
  it("activates Unicode 11 widths", () => {
    const term = new Terminal({ allowProposedApi: true });
    applyUnicode11(term);
    expect(term.unicode.activeVersion).toBe("11");
    term.dispose();
  });
});

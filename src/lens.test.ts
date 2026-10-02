import { describe, expect, it } from "vitest";
import { defaultLens } from "./lens";
const p = (agent: string | null) => ({ pane_id: "w1:p1", terminal_id: "t", title: "x", cwd: "/x", agent, status: "idle" as const });
describe("defaultLens", () => {
  it("prefers remembered, then chat for claude/pi", () => {
    expect(defaultLens(p("claude"), undefined)).toBe("chat");
    expect(defaultLens(p("pi"), undefined)).toBe("chat");
    expect(defaultLens(p("codex"), undefined)).toBe("terminal");
    expect(defaultLens(p(null), undefined)).toBe("terminal");
    expect(defaultLens(p("claude"), "terminal")).toBe("terminal");
  });
});

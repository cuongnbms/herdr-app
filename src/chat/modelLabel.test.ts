import { describe, expect, it } from "vitest";
import { formatTokens, modelLabel } from "./modelLabel";
describe("modelLabel", () => {
  it("joins the Model, effort and context size, or shows whichever is known", () => {
    expect(modelLabel({ model: "claude-opus-5-5", effort: "high", context_tokens: 48612 })).toBe("claude-opus-5-5 · high · 48.6k");
    expect(modelLabel({ model: "claude-opus-5-5", effort: "high", context_tokens: null })).toBe("claude-opus-5-5 · high");
    expect(modelLabel({ model: "claude-opus-5-5", effort: null, context_tokens: null })).toBe("claude-opus-5-5");
    expect(modelLabel({ model: null, effort: "off", context_tokens: null })).toBe("off");
    expect(modelLabel({ model: null, effort: null, context_tokens: 0 })).toBeNull();
    expect(modelLabel(undefined)).toBeNull();
  });
});
describe("formatTokens", () => {
  it("shortens to k and M", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(48612)).toBe("48.6k");
    expect(formatTokens(182400)).toBe("182k");
    expect(formatTokens(1_020_000)).toBe("1.02M");
  });
});

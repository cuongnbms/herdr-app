import { describe, expect, it } from "vitest";
import { modelLabel } from "./modelLabel";
describe("modelLabel", () => {
  it("joins the Model and effort, or shows whichever is known", () => {
    expect(modelLabel({ model: "claude-opus-5-5", effort: "high" })).toBe("claude-opus-5-5 · high");
    expect(modelLabel({ model: "claude-opus-5-5", effort: null })).toBe("claude-opus-5-5");
    expect(modelLabel({ model: null, effort: "off" })).toBe("off");
    expect(modelLabel({ model: null, effort: null })).toBeNull();
    expect(modelLabel(undefined)).toBeNull();
  });
});

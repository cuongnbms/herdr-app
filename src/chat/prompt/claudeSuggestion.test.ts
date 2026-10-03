import { describe, expect, it } from "vitest";
import { parseClaudeSuggestion } from "./claudeSuggestion";

// Screens adapted from herdr-web-ui's server/prompt.test.ts (MIT).
describe("Claude's suggested next prompt", () => {
  // Claude Code 2.1.284 as herdr reads it with ANSI: the grey suggestion in the empty input box
  const RULE = "\u001b[0m\u001b[38;2;136;136;136m" + "─".repeat(60) + "\u001b[0m";
  const screen = (input: string, below = RULE) =>
    [
      "\u001b[0m\u001b[38;2;255;255;255m● \u001b[0m표본 수집이 끝나면 알림이 오도록 걸어 두었습니다.",
      "",
      "\u001b[0m\u001b[38;2;153;153;153m✻ Worked for 2m 14s · done 오후 4:16\u001b[0m",
      RULE,
      input,
      below,
      "  \u001b[0m\u001b[38;5;6m[Opus 5.5 (1M context)]\u001b[0m\u001b[38;2;153;153;153m │ \u001b[0m\u001b[2m\u001b[38;2;153;153;153m⏱️  25h\u001b[0m",
      "  \u001b[0m\u001b[38;2;255;107;128m⏵⏵ bypass permissions on\u001b[0m",
    ].join("\r\n");

  it("reads the grey text in the empty input box", () => {
    expect(parseClaudeSuggestion(screen("❯ \u001b[0m\u001b[2m아직 진행중이야?\u001b[0m"))).toBe("아직 진행중이야?");
    // dim set together with a color, in one sequence
    expect(parseClaudeSuggestion(screen("❯ \u001b[2;38;5;8mrun the tests again\u001b[0m"))).toBe("run the tests again");
  });

  it("finds nothing while text is typed, the box is empty, or it holds Claude's tip", () => {
    expect(parseClaudeSuggestion(screen("❯ 아직 진행중이야?"))).toBeNull();
    // typed text right after a grey remainder is still typed
    expect(parseClaudeSuggestion(screen("❯ \u001b[2m아직\u001b[0m 진행중"))).toBeNull();
    expect(parseClaudeSuggestion(screen("❯ "))).toBeNull();
    expect(parseClaudeSuggestion(screen('❯ \u001b[2mTry "how does <filepath> work?"\u001b[0m'))).toBeNull();
  });

  it("does not take a truecolor foreground for dim: its 2 is the color mode", () => {
    expect(parseClaudeSuggestion(screen("❯ \u001b[38;2;153;153;153mnot a suggestion\u001b[0m"))).toBeNull();
  });

  it("reads only the input box: not a ❯ line without its rules, nor a box of several lines", () => {
    expect(parseClaudeSuggestion(screen("❯ \u001b[2mfirst line\u001b[0m", "  \u001b[2msecond line\u001b[0m"))).toBeNull();
    expect(parseClaudeSuggestion("❯ \u001b[2mloose text\u001b[0m\nmore")).toBeNull();
  });

  it("reads only the live input box, the bottom one: not an earlier box above a bash-mode input", () => {
    const below = RULE + "\r\n\u001b[38;2;255;255;255m● quoted output\u001b[0m\r\n" + RULE + "\r\n! ls\r\n" + RULE;
    expect(parseClaudeSuggestion(screen("❯ \u001b[2mrun deploy --prod\u001b[0m", below))).toBeNull();
  });

  it("reads past Claude's own drawn cursor on the first grey character", () => {
    expect(parseClaudeSuggestion(screen("❯ \u001b[7mr\u001b[27m\u001b[2mun the tests\u001b[22m"))).toBe("run the tests");
    // a typed character under that cursor, with nothing grey after it, is typed
    expect(parseClaudeSuggestion(screen("❯ \u001b[7mr\u001b[27m"))).toBeNull();
    expect(parseClaudeSuggestion(screen("❯ \u001b[7mr\u001b[27mun"))).toBeNull();
  });
});

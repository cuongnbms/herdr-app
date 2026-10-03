import { describe, expect, test } from "vitest";
import { readPrompt } from "./screenPrompt";
import { sendAnswer, type PromptIo } from "./sendAnswer";

const question = (selected: 0 | 1, label = "Fork") => `
☐ Route

Which way should the PR go?

${selected === 0 ? "❯" : " "} 1. Log in as owner
${selected === 1 ? "❯" : " "} 2. ${label}
  3. Type something.
────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;

const piModel = (cursor: 0 | 1 | 2) => `
>

${["a-model [p]", "b-model [p]", "c-model [p]"].map((label, i) => `${i === cursor ? "→" : " "}   ${label}`).join("\n")}

 Enter to select · Ctrl+S to set as default · Escape/Ctrl+C to cancel
────────────────────────
/tmp/app
`;

function fakeIo(screen: string | (() => string)) {
  const sent: (string[] | string)[] = [];
  const io: PromptIo = {
    read: async () => (typeof screen === "string" ? screen : screen()),
    keys: async (keys) => void sent.push(keys),
    text: async (text) => void sent.push(text),
  };
  return { io, sent };
}

describe("sendAnswer", () => {
  test("re-reads the screen and sends the keys from the cursor it shows now", async () => {
    const shown = readPrompt("claude", question(0));
    const { io, sent } = fakeIo(question(1));
    expect(await sendAnswer(io, "claude", shown, { option_index: 0 }, 0)).toEqual({ sent: true });
    expect(sent).toEqual([["up"], ["enter"]]);
  });

  test("types a custom answer as text between its keys", async () => {
    const shown = readPrompt("claude", question(0));
    const { io, sent } = fakeIo(question(0));
    await sendAnswer(io, "claude", shown, { custom_text: " Squash first " }, 0);
    expect(sent).toEqual([["down"], ["down"], "Squash first", ["enter"]]);
  });

  test("sends nothing when the prompt changed, and hands back the new one", async () => {
    const shown = readPrompt("claude", question(0));
    const { io, sent } = fakeIo(question(0, "Fork the repo"));
    const outcome = await sendAnswer(io, "claude", shown, { option_index: 1 }, 0);
    expect(outcome.sent).toBe(false);
    expect(outcome.sent === false && outcome.fresh?.options[1]?.label).toBe("Fork the repo");
    expect(sent).toEqual([]);
  });

  test("presses Enter on pi's model picker only once the cursor is on the chosen model", async () => {
    const shown = readPrompt("pi", piModel(0));
    let cursor: 0 | 1 | 2 = 0;
    const { io, sent } = fakeIo(() => piModel(cursor));
    const keys = io.keys;
    io.keys = async (k) => {
      if (k[0] === "down") cursor = Math.min(2, cursor + 1) as 0 | 1 | 2;
      return keys(k);
    };
    expect(await sendAnswer(io, "pi", shown, { option_index: 2 }, 0)).toEqual({ sent: true });
    expect(sent).toEqual([["down"], ["down"], ["enter"]]);
  });

  test("does not press Enter when the cursor of pi's model picker lands elsewhere", async () => {
    const shown = readPrompt("pi", piModel(0));
    // the screen read before Enter still shows the cursor on the first model
    let reads = 0;
    const { io, sent } = fakeIo(() => piModel(reads++ === 0 ? 0 : 1));
    const outcome = await sendAnswer(io, "pi", shown, { option_index: 2 }, 0);
    expect(outcome.sent).toBe(false);
    expect(sent).toEqual([["down"], ["down"]]);
  });

  test("with the fallback off, hands back no card for a screen no reader knows", async () => {
    const shown = readPrompt("pi", piModel(0));
    const { io, sent } = fakeIo("$ ls\n");
    expect(await sendAnswer(io, "pi", shown, { option_index: 1 }, 0, false)).toEqual({ sent: false, fresh: null });
    expect(sent).toEqual([]);
  });
});

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

function fakeIo(screen: string) {
  const sent: (string[] | string)[] = [];
  const io: PromptIo = {
    read: async () => screen,
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
    expect(outcome.sent === false && outcome.fresh.options[1]?.label).toBe("Fork the repo");
    expect(sent).toEqual([]);
  });
});

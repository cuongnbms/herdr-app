import { answerKeys, readPrompt, type PromptAnswer, type ScreenPrompt } from "./screenPrompt";

/** How the card reaches the pane: read its visible screen, send keys, type text. */
export interface PromptIo {
  read(): Promise<string>;
  keys(keys: string[]): Promise<unknown>;
  text(text: string): Promise<unknown>;
}

export type AnswerOutcome = { sent: true } | { sent: false; fresh: ScreenPrompt };

/** Gap between steps, so the TUI redraws its cursor before the next key lands. */
export const STEP_GAP_MS = 30;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Answers `shown` only if the screen still shows it: the keys move from the cursor's row, so
 * they are worked out from a fresh read, and a prompt that changed meanwhile (another question,
 * a different command) gets nothing and is handed back for the card to show instead.
 */
export async function sendAnswer(
  io: PromptIo,
  agent: string | null,
  shown: ScreenPrompt,
  answer: PromptAnswer,
  gapMs = STEP_GAP_MS,
): Promise<AnswerOutcome> {
  const fresh = readPrompt(agent, await io.read());
  if (fresh.id !== shown.id) return { sent: false, fresh };
  const steps = answerKeys(fresh, answer);
  for (const [i, step] of steps.entries()) {
    if (i > 0 && gapMs > 0) await sleep(gapMs);
    if (step.keys) await io.keys(step.keys);
    if (step.text !== undefined) await io.text(step.text);
  }
  return { sent: true };
}

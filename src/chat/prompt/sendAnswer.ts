import {
  answerKeys,
  cursorLabel,
  cursorTarget,
  parseInteractivePrompt,
  readPrompt,
  type PromptAnswer,
  type ScreenPrompt,
} from "./screenPrompt";

/** How the card reaches the pane: read its visible screen, send keys, type text. */
export interface PromptIo {
  read(): Promise<string>;
  keys(keys: string[]): Promise<unknown>;
  text(text: string): Promise<unknown>;
}

/** `fresh` is null when, with the fallback off, no reader knows the screen any more. */
export type AnswerOutcome = { sent: true } | { sent: false; fresh: ScreenPrompt | null };

/** Gap between steps, so the TUI redraws its cursor before the next key lands. */
export const STEP_GAP_MS = 30;
/** Reads of the screen before an Enter whose row is checked, waiting for the cursor to get there. */
const CURSOR_TRIES = 10;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Answers `shown` only if the screen still shows it: the keys move from the cursor's row, so
 * they are worked out from a fresh read, and a prompt that changed meanwhile (another question,
 * a different command) gets nothing and is handed back for the card to show instead. Where the
 * reader asks for it (pi's model picker), the Enter goes only once the cursor is on the chosen
 * row. With `fallback` off, only a known reader's card counts.
 */
export async function sendAnswer(
  io: PromptIo,
  agent: string | null,
  shown: ScreenPrompt,
  answer: PromptAnswer,
  gapMs = STEP_GAP_MS,
  fallback = true,
): Promise<AnswerOutcome> {
  const parse = (screen: string) => (fallback ? readPrompt(agent, screen) : parseInteractivePrompt(agent ?? "", screen));
  const fresh = parse(await io.read());
  if (fresh?.id !== shown.id) return { sent: false, fresh };
  const steps = answerKeys(fresh, answer);
  const target = cursorTarget(fresh, answer);
  for (const [i, step] of steps.entries()) {
    if (i > 0 && gapMs > 0) await sleep(gapMs);
    if (target !== null && i === steps.length - 1) {
      let now = parse(await io.read());
      for (let tries = 1; cursorLabel(now) !== target && tries < CURSOR_TRIES; tries += 1) {
        if (gapMs > 0) await sleep(gapMs);
        now = parse(await io.read());
      }
      if (cursorLabel(now) !== target) return { sent: false, fresh: now };
    }
    if (step.keys) await io.keys(step.keys);
    if (step.text !== undefined) await io.text(step.text);
  }
  return { sent: true };
}

import type { ChatItem } from "../../lib/types";
import type { ScreenPrompt } from "./screenPrompt";

/** One question of Claude's AskUserQuestion call, as its input names it. */
export interface AskedQuestion {
  question: string;
  options: { label: string; preview: string | null }[];
}

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const words = (value: string) => value.replace(/\s+/g, " ").trim();

/**
 * The questions of the AskUserQuestion call still waiting for its answer: the last one in the
 * transcript with no result yet. Its input holds each option's preview whole, where the screen
 * shows only the cursor's, wrapped to the pane.
 */
export function pendingQuestions(items: ChatItem[]): AskedQuestion[] {
  const answered = new Set(items.flatMap((item) => (item.kind === "tool_result" ? [item.call_id] : [])));
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind !== "tool_call" || item.name !== "AskUserQuestion") continue;
    if (answered.has(item.id)) return [];
    const questions = (item.input as { questions?: unknown } | null)?.questions;
    if (!Array.isArray(questions)) return [];
    return questions.flatMap((q: { question?: unknown; options?: unknown }) => {
      const question = text(q?.question);
      if (question === null || !Array.isArray(q.options)) return [];
      return [{
        question,
        options: q.options.map((o: { label?: unknown; preview?: unknown }) => ({ label: text(o?.label) ?? "", preview: text(o?.preview) })),
      }];
    });
  }
  return [];
}

/**
 * Each of `prompt`'s options' preview from the call it answers, by the question's words and the
 * options' count and labels; null when the screen's question is not one of the call's (a
 * label a narrow pane cut short still matches by its start).
 */
export function previewsFor(prompt: ScreenPrompt, asked: AskedQuestion[]): (string | null)[] | null {
  const match = asked.find((q) => words(q.question) === words(prompt.question)
    && q.options.length === prompt.options.length
    && q.options.every((o, i) => words(o.label).startsWith(words(prompt.options[i]!.label).replace(/…$/, ""))));
  if (!match || match.options.every((o) => o.preview === null)) return null;
  return match.options.map((o) => o.preview);
}

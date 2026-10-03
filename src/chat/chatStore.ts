import type { AppError, ChatEvent, ChatItem, ChatMeta } from "../lib/types";

export interface ChatState {
  items: ChatItem[];
  total: number;
  error: AppError | null;
  meta: ChatMeta;
}

export const emptyChat: ChatState = { items: [], total: 0, error: null, meta: { model: null, effort: null, context_tokens: null } };

export const TRIM_AT = 2000;
export const TRIM_TO = 1000;

export function reduce(state: ChatState, ev: ChatEvent, atBottom = false): ChatState {
  switch (ev.type) {
    case "reset":
      return { items: ev.items, total: ev.total, error: null, meta: state.meta };
    case "append":
    {
      let items = [...state.items, ...ev.items];
      // Keep a suffix of the tail's items so paging by total - items.length still lines up.
      if (atBottom && items.length > TRIM_AT) items = items.slice(-TRIM_TO);
      return { ...state, items, total: state.total + ev.items.length };
    }
    case "meta":
      return { ...state, meta: { model: ev.model, effort: ev.effort, context_tokens: ev.context_tokens } };
    case "error":
      return { ...state, error: ev.error };
  }
}

export function prepend(state: ChatState, older: ChatItem[]): ChatState {
  return { ...state, items: [...older, ...state.items] };
}

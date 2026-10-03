import type { AppError, ChatEvent, ChatItem, ChatMeta } from "../lib/types";

export interface ChatState {
  items: ChatItem[];
  total: number;
  error: AppError | null;
  meta: ChatMeta;
}

export const emptyChat: ChatState = { items: [], total: 0, error: null, meta: { model: null, effort: null } };

export function reduce(state: ChatState, ev: ChatEvent): ChatState {
  switch (ev.type) {
    case "reset":
      return { items: ev.items, total: ev.total, error: null, meta: state.meta };
    case "append":
      return { ...state, items: [...state.items, ...ev.items], total: state.total + ev.items.length };
    case "meta":
      return { ...state, meta: { model: ev.model, effort: ev.effort } };
    case "error":
      return { ...state, error: ev.error };
  }
}

export function prepend(state: ChatState, older: ChatItem[]): ChatState {
  return { ...state, items: [...older, ...state.items] };
}

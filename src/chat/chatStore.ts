import type { AppError, ChatEvent, ChatItem } from "../lib/types";

export interface ChatState {
  items: ChatItem[];
  total: number;
  error: AppError | null;
}

export const emptyChat: ChatState = { items: [], total: 0, error: null };

export function reduce(state: ChatState, ev: ChatEvent): ChatState {
  switch (ev.type) {
    case "reset":
      return { items: ev.items, total: ev.total, error: null };
    case "append":
      return { ...state, items: [...state.items, ...ev.items], total: state.total + ev.items.length };
    case "error":
      return { ...state, error: ev.error };
  }
}

export function prepend(state: ChatState, older: ChatItem[]): ChatState {
  return { ...state, items: [...older, ...state.items] };
}

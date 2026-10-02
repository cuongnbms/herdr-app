import { useSyncExternalStore } from "react";

export interface ToastItem {
  id: number;
  text: string;
}

const DISMISS_MS = 5000;
let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());

export function dismissToast(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

/** Show a toast that dismisses itself after 5 s. */
export function showToast(text: string) {
  const id = nextId++;
  items = [...items, { id, text }];
  emit();
  setTimeout(() => dismissToast(id), DISMISS_MS);
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};
const snapshot = () => items;

export function Toasts() {
  const list = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (list.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className="toast">
          {t.text}
        </div>
      ))}
    </div>
  );
}

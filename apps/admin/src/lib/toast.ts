// Notifications for admin actions, shown in the lower-right corner by
// <ToastViewport /> (mounted once in AdminShell). A plain module store, so
// any screen or helper can call pushToast() without a provider.
import { useSyncExternalStore } from "react";
import type { Toast } from "@etymos/shared";

let toasts: Toast[] = [];
const listeners = new Set<() => void>();

function emit(next: Toast[]) {
  toasts = next;
  for (const listener of listeners) listener();
}

/** `title` and `description` are shown as given: translate them first. */
export function pushToast(toast: Omit<Toast, "id">): void {
  emit([...toasts, { ...toast, id: Math.random().toString(36).slice(2) }]);
}

export function dismissToast(id: string): void {
  emit(toasts.filter((toast) => toast.id !== id));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, () => toasts);
}

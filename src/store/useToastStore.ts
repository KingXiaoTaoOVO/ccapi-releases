import { create } from "zustand";
import { uid } from "@/lib/format";

export type ToastTone = "success" | "error" | "info" | "warning";

export interface ToastItem {
  id: string;
  tone: ToastTone;
  title: string;
  message?: string;
  duration: number;
}

interface ToastState {
  toasts: ToastItem[];
  push: (t: Omit<ToastItem, "id" | "duration"> & { duration?: number }) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

/**
 * Cap on simultaneously visible toasts. A failover storm or hook error loop
 * can otherwise blanket the screen — when the cap is reached we drop the
 * oldest entry so the newest still surfaces.
 */
const MAX_VISIBLE_TOASTS = 5;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (t) => {
    const id = uid("toast");
    const duration = t.duration ?? 4000;
    set((s) => {
      // Collapse exact duplicates already on screen — return the existing id
      // instead of stacking another card. Same title+message+tone within the
      // last few seconds is almost always the same event firing twice.
      const existing = s.toasts.find(
        (x) => x.tone === t.tone && x.title === t.title && x.message === t.message,
      );
      if (existing) return s;
      const next = [...s.toasts, { ...t, id, duration }];
      if (next.length > MAX_VISIBLE_TOASTS) {
        next.splice(0, next.length - MAX_VISIBLE_TOASTS);
      }
      return { toasts: next };
    });
    if (duration > 0) {
      setTimeout(() => get().dismiss(id), duration);
    }
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}));

/** Imperative helper usable from anywhere (services, stores, components). */
export const toast = {
  success: (title: string, message?: string) =>
    useToastStore.getState().push({ tone: "success", title, message }),
  error: (title: string, message?: string) =>
    useToastStore.getState().push({ tone: "error", title, message, duration: 6000 }),
  info: (title: string, message?: string) =>
    useToastStore.getState().push({ tone: "info", title, message }),
  warning: (title: string, message?: string) =>
    useToastStore.getState().push({ tone: "warning", title, message, duration: 5000 }),
};

import { create } from "zustand";

import type { PromptRequest } from "@/components/PromptDialog";

interface PromptStore {
  open: boolean;
  request: PromptRequest | null;
  loading: boolean;
  resolver: ((v: Record<string, string> | null) => void) | null;
  ask: (req: PromptRequest) => Promise<Record<string, string> | null>;
  submit: (values: Record<string, string>) => void;
  cancel: () => void;
  setLoading: (b: boolean) => void;
}

export const usePromptStore = create<PromptStore>((set, get) => ({
  open: false,
  request: null,
  loading: false,
  resolver: null,
  ask: (req) =>
    new Promise<Record<string, string> | null>((resolve) => {
      set({ open: true, request: req, resolver: resolve, loading: false });
    }),
  submit: (values) => {
    const r = get().resolver;
    set({ open: false, request: null, resolver: null, loading: false });
    r?.(values);
  },
  cancel: () => {
    const r = get().resolver;
    set({ open: false, request: null, resolver: null, loading: false });
    r?.(null);
  },
  setLoading: (b) => set({ loading: b }),
}));

/** 便捷调用：`const r = await prompt({title:'…', fields:[…]}); if (!r) return;` */
export const prompt = (req: PromptRequest) => usePromptStore.getState().ask(req);

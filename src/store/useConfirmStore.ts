import { create } from "zustand";

import type { ConfirmRequest } from "@/components/ConfirmDialog";

interface ConfirmStore {
  open: boolean;
  request: ConfirmRequest | null;
  loading: boolean;
  resolver: ((v: boolean) => void) | null;
  ask: (req: ConfirmRequest) => Promise<boolean>;
  confirm: () => void;
  cancel: () => void;
  setLoading: (b: boolean) => void;
}

export const useConfirmStore = create<ConfirmStore>((set, get) => ({
  open: false,
  request: null,
  loading: false,
  resolver: null,
  ask: (req) =>
    new Promise<boolean>((resolve) => {
      set({ open: true, request: req, resolver: resolve, loading: false });
    }),
  confirm: () => {
    const r = get().resolver;
    set({ open: false, request: null, resolver: null, loading: false });
    r?.(true);
  },
  cancel: () => {
    const r = get().resolver;
    set({ open: false, request: null, resolver: null, loading: false });
    r?.(false);
  },
  setLoading: (b) => set({ loading: b }),
}));

/** 便捷调用：`if (await confirm({title:'…'})) { … }` */
export const confirm = (req: ConfirmRequest) =>
  useConfirmStore.getState().ask(req);

import { create } from "zustand";
import { t } from "@/i18n";
import { toast } from "@/store/useToastStore";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import {
  checkForUpdate,
  installUpdate,
  type InstallProgress,
  type UpdateInfo,
} from "@/services/updater";

export type UpdatePhase = "idle" | "checking" | "available" | "installing" | "ready" | "error";

interface UpdateState {
  phase: UpdatePhase;
  /** Available update payload (null until check resolves with a newer build). */
  info: UpdateInfo | null;
  /** Last user-facing error message if any. */
  error: string | null;
  /** Download progress while phase === "installing". */
  progress: { downloaded: number; total?: number } | null;
  /** Show / hide the update modal. */
  modalOpen: boolean;

  /**
   * Run a check.
   * - `silent`: don't toast if no update is found (used by the auto-check).
   * - `manual`: surface every outcome (no-update / error / found).
   */
  check: (opts?: { silent?: boolean }) => Promise<void>;
  startInstall: () => Promise<void>;
  openModal: () => void;
  closeModal: () => void;
  reset: () => void;
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  phase: "idle",
  info: null,
  error: null,
  progress: null,
  modalOpen: false,

  check: async (opts) => {
    if (get().phase === "checking" || get().phase === "installing") return;
    const silent = opts?.silent === true;
    const wsLog = useWorkspaceStore.getState().log;
    set({ phase: "checking", error: null });
    try {
      const info = await checkForUpdate();
      if (info) {
        set({ phase: "available", info, modalOpen: true });
        wsLog("info", "updater", t("update.foundLog", { version: info.version }));
      } else {
        set({ phase: "idle", info: null });
        if (!silent) toast.success(t("update.upToDate"));
      }
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      set({ phase: "error", error: msg });
      wsLog("error", "updater", t("update.checkFailed"), msg);
      if (!silent) toast.error(t("update.checkFailed"), msg);
    }
  },

  startInstall: async () => {
    const { info } = get();
    if (!info || get().phase === "installing") return;
    const wsLog = useWorkspaceStore.getState().log;
    set({ phase: "installing", progress: { downloaded: 0 } });
    try {
      await installUpdate(info.handle, (p: InstallProgress) => {
        set({
          progress: { downloaded: p.downloaded, total: p.total },
          phase: p.phase === "installed" ? "ready" : "installing",
        });
      });
      set({ phase: "ready" });
      wsLog("info", "updater", t("update.installedLog", { version: info.version }));
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      set({ phase: "error", error: msg });
      wsLog("error", "updater", t("update.installFailed"), msg);
      toast.error(t("update.installFailed"), msg);
    }
  },

  openModal: () => set({ modalOpen: true }),
  closeModal: () => set({ modalOpen: false }),
  reset: () =>
    set({
      phase: "idle",
      info: null,
      error: null,
      progress: null,
      modalOpen: false,
    }),
}));

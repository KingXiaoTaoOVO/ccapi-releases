import { useCallback, useState } from "react";
import type { BackupEntry } from "@/types";
import { useAppStore } from "@/store/useAppStore";
import { toast } from "@/store/useToastStore";
import { t } from "@/i18n";
import {
  backupConfig,
  listBackups,
  restoreConfig,
} from "@/services/configManager";
import { clearAppCaches } from "@/services/tauri";

/**
 * Read/write access to Claude Code's config file plus backup management.
 * Wraps the store's live `claudeConfig` with backup/restore helpers.
 */
export function useConfigFile() {
  const claudeConfig = useAppStore((s) => s.claudeConfig);
  const refresh = useAppStore((s) => s.refreshClaudeConfig);
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [busy, setBusy] = useState(false);

  const loadBackups = useCallback(async () => {
    try {
      setBackups(await listBackups());
    } catch (e) {
      console.error(e);
    }
  }, []);

  const doBackup = useCallback(async () => {
    setBusy(true);
    try {
      await backupConfig();
      await loadBackups();
      toast.success(t("cfg.backedUp"), t("cfg.backedUpDesc"));
    } catch (e) {
      toast.error(t("cfg.backupFailed"), String(e));
    } finally {
      setBusy(false);
    }
  }, [loadBackups]);

  const doRestore = useCallback(
    async (fileName: string) => {
      setBusy(true);
      try {
        await restoreConfig(fileName);
        await refresh();
        await loadBackups();
        toast.success(t("cfg.restored"), t("cfg.restoredDesc"));
      } catch (e) {
        toast.error(t("cfg.restoreFailed"), String(e));
      } finally {
        setBusy(false);
      }
    },
    [refresh, loadBackups],
  );

  const doClearCaches = useCallback(async () => {
    setBusy(true);
    try {
      const report = await clearAppCaches();
      await loadBackups();
      const kb = Math.round(report.bytesReclaimed / 1024);
      toast.success(
        t("set.cleanTitle"),
        t("set.cleanDone", {
          b: report.backupsRemoved,
          l: report.logsRemoved,
          kb,
        }),
      );
      return report;
    } catch (e) {
      toast.error(t("set.cleanTitle"), String(e));
      throw e;
    } finally {
      setBusy(false);
    }
  }, [loadBackups]);

  return {
    claudeConfig,
    refresh,
    backups,
    loadBackups,
    doBackup,
    doRestore,
    doClearCaches,
    busy,
  };
}

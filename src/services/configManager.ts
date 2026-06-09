import type { ApiKey, AppSettings } from "@/types";
import {
  backupConfig,
  listBackups,
  migrateToProxy,
  readClaudeConfig,
  restoreConfig,
} from "./tauri";

export { readClaudeConfig, backupConfig, listBackups, restoreConfig };

/**
 * Point Claude Code at the local proxy. Regardless of which upstream key is
 * currently active, the only credential ever written into Claude's
 * `settings.json` is the **proxy URL + proxy token** — real third-party
 * URLs and KEYs stay inside this app's own storage and never leak out.
 *
 * The `_key` parameter is kept for call-site compatibility (most callers pass
 * the freshly-activated upstream key) but its value is intentionally ignored.
 */
export function activateKeyInClaude(
  _key: ApiKey | null,
  settings: AppSettings,
  backup = settings.autoBackup,
): Promise<string> {
  return migrateToProxy({
    port: settings.proxyPort,
    token: settings.proxyKey,
    backup,
  });
}

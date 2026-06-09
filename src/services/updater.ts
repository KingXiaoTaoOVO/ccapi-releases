import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import {
  enable as enableAutostart,
  disable as disableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";

/**
 * Thin wrappers around the Tauri updater / autostart plugins. Components and
 * stores import from here so we never reach into the plugin packages
 * directly — keeps the dependency surface small and mockable.
 */

export interface UpdateInfo {
  /** New version available on the remote endpoint. */
  version: string;
  /** Current installed version, for the UI diff. */
  currentVersion: string;
  /** Markdown body from the GitHub Release (changelog). */
  notes: string;
  /** ISO 8601 publish date, when the remote feed includes it. */
  date?: string;
  /** Raw download size in bytes when the feed reports it (best-effort). */
  contentLength?: number;
  /** Opaque handle the caller passes back to install(). */
  handle: Update;
}

/**
 * Hit the updater endpoint (configured in tauri.conf.json) and return
 * structured info when a newer version is available, or null otherwise.
 * Throws when the endpoint is unreachable or signed with a mismatched key.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const current = await getVersion();
  const update = await check();
  if (!update?.available) return null;
  return {
    version: update.version,
    currentVersion: current,
    notes: update.body ?? "",
    date: update.date ?? undefined,
    contentLength: undefined,
    handle: update,
  };
}

export interface InstallProgress {
  /** Bytes downloaded so far in the current segment. */
  downloaded: number;
  /** Total bytes when known (depends on the platform). */
  total?: number;
  /** Discriminator for the lifecycle event. */
  phase: "started" | "downloading" | "finished" | "installed";
}

/**
 * Download + install the update, streaming progress events into `onProgress`.
 * Calls relaunch() once the install finishes so the user lands on the new
 * version without manually closing the app. The platform installer takes
 * care of overwriting the old binary.
 */
export async function installUpdate(
  update: Update,
  onProgress?: (p: InstallProgress) => void,
): Promise<void> {
  let downloaded = 0;
  let total: number | undefined;
  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? undefined;
        onProgress?.({ downloaded: 0, total, phase: "started" });
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        onProgress?.({ downloaded, total, phase: "downloading" });
        break;
      case "Finished":
        onProgress?.({ downloaded, total, phase: "finished" });
        break;
    }
  });
  onProgress?.({ downloaded, total, phase: "installed" });
  await relaunch();
}

export async function getAppVersion(): Promise<string> {
  return getVersion();
}

export async function setAutostart(enabled: boolean): Promise<boolean> {
  if (enabled) {
    await enableAutostart();
  } else {
    await disableAutostart();
  }
  return isAutostartEnabled();
}

export async function isAutostart(): Promise<boolean> {
  return isAutostartEnabled();
}

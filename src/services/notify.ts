import { toast, type ToastTone } from "@/store/useToastStore";
import { notifySystem } from "./tauri";

/**
 * Unified notification entry point.
 *
 * Every call shows an in-app toast (always). When desktop notifications are
 * enabled it *also* fires a native OS popup (Windows toast / macOS / Linux) so
 * important events reach the user even when the window is hidden to the tray.
 *
 * Lives in its own module (not in the store) to avoid an import cycle:
 * `useAppStore` → `notify` → (`useToastStore` + `tauri`). It never imports the
 * app store, so the enabled flag is pushed in via `setDesktopNotifications`.
 */

let desktopEnabled = true;

/** Sync the global desktop-notification preference (called from the store). */
export function setDesktopNotifications(on: boolean): void {
  desktopEnabled = on;
}

export interface NotifyOpts {
  /** Force-disable the native popup for this call (in-app toast still shows). */
  desktop?: boolean;
  /** Override the body shown in the native OS notification (toast keeps `message`). */
  desktopBody?: string;
}

/** Fire an in-app toast and, when enabled, a native OS notification. */
export function notify(
  tone: ToastTone,
  title: string,
  message?: string,
  opts?: NotifyOpts,
): void {
  toast[tone](title, message);

  const wantDesktop = opts?.desktop !== false && desktopEnabled;
  if (wantDesktop) {
    notifySystem(title, opts?.desktopBody ?? message ?? "").catch((e) => {
      // Native popups are best-effort — the in-app toast already fired.
      console.error("系统通知发送失败", e);
    });
  }
}

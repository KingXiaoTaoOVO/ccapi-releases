import { toast, type ToastTone } from "@/store/useToastStore";
import { notifySystem } from "./tauri";

/**
 * Unified notification entry point.
 *
 * Every call shows an in-app toast (always). When desktop notifications are
 * enabled it *also* fires a native OS popup (Windows toast / macOS / Linux) —
 * but only when the main window is NOT in the foreground. When the user is
 * actively looking at CCAPI, an in-app toast is enough; an OS popup on top of
 * it is noisy duplication. When the window is hidden to the tray, minimised,
 * or sitting behind another app, the OS popup is the only way the user finds
 * out, so we still fire it then.
 *
 * Lives in its own module (not in the store) to avoid an import cycle:
 * `useAppStore` → `notify` → (`useToastStore` + `tauri`). It never imports the
 * app store, so the enabled flag is pushed in via `setDesktopNotifications`.
 */

let desktopEnabled = true;

// Track the webview's foreground state so `notify()` stays synchronous. The
// browser APIs `document.hasFocus()` / `visibilityState` already reflect the
// Tauri window: minimised / hidden windows report `hidden`, and switching to
// another app blurs the webview.
let hasFocus =
  typeof document !== "undefined" ? document.hasFocus() : false;
let isVisible =
  typeof document !== "undefined"
    ? document.visibilityState === "visible"
    : false;

if (typeof window !== "undefined") {
  window.addEventListener("focus", () => {
    hasFocus = true;
  });
  window.addEventListener("blur", () => {
    hasFocus = false;
  });
  document.addEventListener("visibilitychange", () => {
    isVisible = document.visibilityState === "visible";
  });
}

function isForeground(): boolean {
  return hasFocus && isVisible;
}

/** Sync the global desktop-notification preference (called from the store). */
export function setDesktopNotifications(on: boolean): void {
  desktopEnabled = on;
}

export interface NotifyOpts {
  /** Force-disable the native popup for this call (in-app toast still shows). */
  desktop?: boolean;
  /** Override the body shown in the native OS notification (toast keeps `message`). */
  desktopBody?: string;
  /**
   * Force the native popup even when the window is in the foreground. Reserved
   * for genuinely urgent events (e.g. "all keys are unusable") where doubling
   * up on the toast is acceptable. Defaults to false.
   */
  forceDesktop?: boolean;
}

/** Fire an in-app toast and, when enabled AND the window is in the background,
 *  a native OS notification. */
export function notify(
  tone: ToastTone,
  title: string,
  message?: string,
  opts?: NotifyOpts,
): void {
  toast[tone](title, message);

  const allowed = opts?.desktop !== false && desktopEnabled;
  const background = !isForeground();
  const wantDesktop = allowed && (background || opts?.forceDesktop === true);

  if (wantDesktop) {
    notifySystem(title, opts?.desktopBody ?? message ?? "").catch((e) => {
      // Native popups are best-effort — the in-app toast already fired.
      console.error("系统通知发送失败", e);
    });
  }
}

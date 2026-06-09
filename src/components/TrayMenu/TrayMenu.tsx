import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import {
  LayoutDashboard,
  LogOut,
  Monitor,
  RefreshCw,
  Settings as SettingsIcon,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useT } from "@/i18n";

const win = getCurrentWindow();

/** Mirror the app's light/dark choice (written to localStorage by the main window). */
function applyTheme() {
  try {
    const resolved = localStorage.getItem("ccapi.resolvedTheme");
    document.documentElement.classList.toggle("dark", resolved === "dark");
  } catch {
    /* ignore */
  }
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
  danger,
}: {
  icon: typeof Zap;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors",
        danger
          ? "text-danger hover:bg-danger/12"
          : "text-text hover:bg-primary/12 hover:text-primary",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

/**
 * Custom-styled system-tray popup menu, rendered in a frameless transparent
 * window that the Rust side positions at the cursor on right-click. Mirrors the
 * app's glass UI so the tray menu matches the rest of CCAPI.
 */
export function TrayMenu() {
  const t = useT();
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Transparent backdrop so the glass card floats over the desktop.
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    applyTheme();

    // Size the window snugly around the menu card (after layout settles).
    const raf = requestAnimationFrame(() => {
      const el = cardRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // +10px margin keeps the card's soft shadow from being clipped.
      win.setSize(new LogicalSize(Math.ceil(r.width) + 10, Math.ceil(r.height) + 10)).catch(() => {});
    });

    // Dismiss the menu when it loses focus (click elsewhere / Esc-blur).
    const unlisten = win.onFocusChanged(({ payload: focused }) => {
      if (!focused) win.hide().catch(() => {});
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") win.hide().catch(() => {});
    };
    const onStorage = () => applyTheme();
    window.addEventListener("keydown", onKey);
    window.addEventListener("storage", onStorage);

    return () => {
      cancelAnimationFrame(raf);
      unlisten.then((f) => f());
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const run = (action: string) => {
    invoke("tray_action", { action }).catch(() => {});
  };

  return (
    <div className="flex min-h-screen w-screen items-start justify-center p-[5px]">
      <div
        ref={cardRef}
        className="glass w-[208px] rounded-xl p-1.5 shadow-card"
      >
        <MenuItem icon={Monitor} label={t("tray.show")} onClick={() => run("show")} />
        <div className="my-1 h-px bg-border/70" />
        <MenuItem icon={LayoutDashboard} label={t("tray.dashboard")} onClick={() => run("nav:dashboard")} />
        <MenuItem icon={SettingsIcon} label={t("tray.settings")} onClick={() => run("nav:settings")} />
        <div className="my-1 h-px bg-border/70" />
        <MenuItem icon={Zap} label={t("tray.rotate")} onClick={() => run("rotate")} />
        <MenuItem icon={RefreshCw} label={t("tray.checkAll")} onClick={() => run("checkAll")} />
        <div className="my-1 h-px bg-border/70" />
        <MenuItem icon={LogOut} label={t("tray.quit")} onClick={() => run("quit")} danger />
      </div>
    </div>
  );
}

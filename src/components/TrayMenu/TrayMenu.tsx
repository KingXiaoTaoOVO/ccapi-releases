import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import {
  LayoutDashboard,
  LogOut,
  Monitor,
  RefreshCw,
  Server as ServerIcon,
  User as UserIcon,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useT } from "@/i18n";
import type { AuthSession } from "@/types/auth";

const win = getCurrentWindow();

const SESSION_KEY = "ccapi.session";

/** Mirror the app's light/dark choice (written to localStorage by the main window). */
function applyTheme() {
  try {
    const resolved = localStorage.getItem("ccapi.resolvedTheme");
    document.documentElement.classList.toggle("dark", resolved === "dark");
  } catch {
    /* ignore */
  }
}

/** Read the persisted auth session (main window writes it on login/logout). */
function readSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AuthSession;
  } catch {
    return null;
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

function Divider() {
  return <div className="my-1 h-px bg-border/70" />;
}

/**
 * Custom-styled system-tray popup menu, rendered in a frameless transparent
 * window that the Rust side positions at the cursor on right-click. Mirrors the
 * app's glass UI so the tray menu matches the rest of CCAPI.
 *
 * The menu adapts to the current auth state:
 *   • not logged in → only "show" + "quit"
 *   • logged in as admin (scope=server) → dashboard + server config
 *   • logged in as client (scope=client) → dashboard + profile + rotate + checkAll
 */
export function TrayMenu() {
  const t = useT();
  const cardRef = useRef<HTMLDivElement>(null);
  const [session, setSession] = useState<AuthSession | null>(() => readSession());

  // Track theme + session through storage events fired by the main window.
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    applyTheme();

    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === "ccapi.resolvedTheme") applyTheme();
      if (e.key === null || e.key === SESSION_KEY) setSession(readSession());
    };

    // Re-read session each time the window is shown (handles cases where the
    // storage event was missed, e.g. window hidden during login).
    const unlistenFocus = win.onFocusChanged(({ payload: focused }) => {
      if (focused) setSession(readSession());
      else win.hide().catch(() => {});
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") win.hide().catch(() => {});
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("storage", onStorage);
    return () => {
      unlistenFocus.then((f) => f());
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // Size the window snugly around the menu card whenever its content changes.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const el = cardRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      win
        .setSize(new LogicalSize(Math.ceil(r.width) + 10, Math.ceil(r.height) + 10))
        .catch(() => {});
    });
    return () => cancelAnimationFrame(raf);
  }, [session]);

  const run = (action: string) => {
    invoke("tray_action", { action }).catch(() => {});
  };

  // A user that must change their password isn't really "in" the app yet —
  // hide the nav items so they can only show the window or quit.
  const activated = !!session && !session.user.mustChangePassword;
  const isAdmin = activated && session!.scope === "server";
  const isClient = activated && session!.scope === "client";

  return (
    <div className="flex min-h-screen w-screen items-start justify-center p-[5px]">
      <div ref={cardRef} className="glass w-[208px] rounded-xl p-1.5 shadow-card">
        <MenuItem icon={Monitor} label={t("tray.show")} onClick={() => run("show")} />

        {isAdmin && (
          <>
            <Divider />
            <MenuItem
              icon={LayoutDashboard}
              label={t("tray.dashboard")}
              onClick={() => run("nav:dashboard")}
            />
            <MenuItem
              icon={ServerIcon}
              label={t("tray.serverConfig")}
              onClick={() => run("nav:settings")}
            />
          </>
        )}

        {isClient && (
          <>
            <Divider />
            <MenuItem
              icon={LayoutDashboard}
              label={t("tray.dashboard")}
              onClick={() => run("nav:dashboard")}
            />
            <MenuItem
              icon={UserIcon}
              label={t("tray.profile")}
              onClick={() => run("nav:settings")}
            />
            <Divider />
            <MenuItem icon={Zap} label={t("tray.rotate")} onClick={() => run("rotate")} />
            <MenuItem
              icon={RefreshCw}
              label={t("tray.checkAll")}
              onClick={() => run("checkAll")}
            />
          </>
        )}

        <Divider />
        <MenuItem icon={LogOut} label={t("tray.quit")} onClick={() => run("quit")} danger />
      </div>
    </div>
  );
}


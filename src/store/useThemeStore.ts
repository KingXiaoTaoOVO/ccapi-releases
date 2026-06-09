import { create } from "zustand";
import type { Theme } from "@/types";

type Resolved = "light" | "dark";

interface ThemeState {
  theme: Theme;
  resolved: Resolved;
  /** Set the preference and immediately apply it to the DOM. */
  setTheme: (theme: Theme) => void;
  /** Begin watching the OS colour-scheme (call once at startup). */
  initSystemWatch: () => void;
}

function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
  );
}

function resolve(theme: Theme): Resolved {
  if (theme === "system") return systemPrefersDark() ? "dark" : "light";
  return theme;
}

function applyToDom(resolved: Resolved) {
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
  // Mirror the resolved theme to localStorage so the separate tray-menu webview
  // window (same origin) can match the app's light/dark appearance.
  try {
    localStorage.setItem("ccapi.resolvedTheme", resolved);
  } catch {
    /* ignore */
  }
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: "system",
  resolved: resolve("system"),

  setTheme: (theme) => {
    const resolved = resolve(theme);
    applyToDom(resolved);
    set({ theme, resolved });
  },

  initSystemWatch: () => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (get().theme === "system") {
        const resolved = resolve("system");
        applyToDom(resolved);
        set({ resolved });
      }
    };
    mq.addEventListener("change", handler);
    // apply current immediately
    applyToDom(get().resolved);
  },
}));

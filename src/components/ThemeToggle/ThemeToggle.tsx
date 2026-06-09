import { useRef } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import gsap from "gsap";
import type { Theme } from "@/types";
import { useThemeStore } from "@/store/useThemeStore";
import { useThemeTransition } from "@/hooks/useThemeTransition";
import { prefersReducedMotion } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import { cn } from "@/lib/cn";

const ORDER: Theme[] = ["light", "dark", "system"];
const ICONS: Record<Theme, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};
const LABEL_KEYS: Record<Theme, MessageKey> = {
  light: "theme.light",
  dark: "theme.dark",
  system: "theme.system",
};

export function ThemeToggle() {
  const t = useT();
  const theme = useThemeStore((s) => s.theme);
  const transition = useThemeTransition();
  const iconRef = useRef<HTMLSpanElement>(null);
  const Icon = ICONS[theme];

  const cycle = (e: React.MouseEvent) => {
    const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
    if (!prefersReducedMotion() && iconRef.current) {
      gsap.fromTo(
        iconRef.current,
        { rotate: -90, opacity: 0, scale: 0.5 },
        { rotate: 0, opacity: 1, scale: 1, duration: 0.45, ease: "back.out(2)" },
      );
    }
    transition(next, { x: e.clientX, y: e.clientY });
  };

  return (
    <button
      onClick={cycle}
      title={t("theme.tooltip", { name: t(LABEL_KEYS[theme]) })}
      className={cn(
        "no-drag group relative flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-xl border border-border",
        "bg-surface-2 px-3 text-sm text-muted hover:text-text hover:border-primary/40",
        "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
      )}
    >
      <span ref={iconRef} className="shrink-0 text-primary">
        <Icon className="h-4 w-4" />
      </span>
      <span className="hidden sm:inline">{t(LABEL_KEYS[theme])}</span>
    </button>
  );
}

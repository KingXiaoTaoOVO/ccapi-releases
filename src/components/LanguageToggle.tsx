import { useRef } from "react";
import { Languages } from "lucide-react";
import gsap from "gsap";
import { useI18n } from "@/i18n";
import { LANGS } from "@/i18n/messages";
import { prefersReducedMotion } from "@/hooks/useGSAPAnim";
import { cn } from "@/lib/cn";

export function LanguageToggle() {
  const lang = useI18n((s) => s.lang);
  const toggle = useI18n((s) => s.toggle);
  const t = useI18n((s) => s.t);
  const labelRef = useRef<HTMLSpanElement>(null);

  const current = LANGS.find((l) => l.value === lang);
  const nextLabel = LANGS.find((l) => l.value !== lang)?.label ?? "";

  const onClick = () => {
    if (!prefersReducedMotion() && labelRef.current) {
      gsap.fromTo(
        labelRef.current,
        { y: 8, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.35, ease: "power2.out" },
      );
    }
    toggle();
  };

  return (
    <button
      onClick={onClick}
      title={t("lang.tooltip", { name: nextLabel })}
      className={cn(
        "no-drag group flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-xl border border-border",
        "bg-surface-2 px-3 text-sm text-muted hover:text-text hover:border-primary/40",
        "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
      )}
    >
      <Languages className="h-4 w-4 shrink-0 text-primary" />
      <span ref={labelRef} className="font-medium">
        {current?.short}
      </span>
    </button>
  );
}

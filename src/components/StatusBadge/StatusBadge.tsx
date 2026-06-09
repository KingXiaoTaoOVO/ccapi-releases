import { cn } from "@/lib/cn";
import type { KeyStatus } from "@/types";
import { STATUS_META, TONE_CLASSES } from "@/lib/status";
import { usePulse } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";

interface StatusBadgeProps {
  status: KeyStatus;
  className?: string;
  /** Render a compact dot + label. */
  size?: "sm" | "md";
}

export function StatusBadge({ status, className, size = "md" }: StatusBadgeProps) {
  const t = useT();
  const meta = STATUS_META[status];
  const tone = TONE_CLASSES[meta.tone];
  // Pulse the badge whenever the status value changes.
  const ref = usePulse<HTMLSpanElement>(status);

  return (
    <span
      ref={ref}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border font-medium",
        size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs",
        tone.bg,
        tone.border,
        tone.text,
        className,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", tone.dot)} />
      {t(meta.labelKey)}
    </span>
  );
}

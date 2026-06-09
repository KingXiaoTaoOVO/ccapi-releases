import { useState } from "react";
import { Edit3, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { useT } from "@/i18n";
import { Switch } from "@/components/ui/Switch";
import { timeAgo } from "@/lib/format";

interface EntityCardProps {
  title: string;
  subtitle?: string;
  /** Right-aligned status pill or badge cluster shown next to the title. */
  badges?: React.ReactNode;
  /** Toggle controls enabled/disabled. Omit to hide the switch. */
  enabled?: boolean;
  onToggle?: (next: boolean) => void;
  onEdit?: () => void;
  onDelete?: () => void;
  /** Optional ISO updatedAt timestamp shown in the footer. */
  updatedAt?: string;
  /** Body section (e.g. a preview snippet). */
  children?: React.ReactNode;
  /** Extra controls inserted between the body and the trash button. */
  extraActions?: React.ReactNode;
}

/**
 * Generic glass card used by Skills / MCP / Rules / Agents views. Keeps the
 * toggle, edit and confirm-delete affordances visually consistent.
 */
export function EntityCard({
  title,
  subtitle,
  badges,
  enabled,
  onToggle,
  onEdit,
  onDelete,
  updatedAt,
  children,
  extraActions,
}: EntityCardProps) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);

  return (
    <article className="flex flex-col gap-3 rounded-2xl border border-border bg-surface/50 p-4 shadow-soft backdrop-blur-md transition-colors hover:border-primary/30">
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{title}</h3>
          {subtitle && (
            <p className="mt-0.5 truncate text-xs text-muted">{subtitle}</p>
          )}
        </div>
        {badges && <div className="flex shrink-0 items-center gap-2">{badges}</div>}
      </header>

      {children && <div className="text-xs leading-relaxed text-muted/90">{children}</div>}

      <footer className="mt-1 flex items-center gap-2">
        {onToggle && (
          <Switch
            checked={enabled ?? false}
            onChange={onToggle}
            label={enabled ? t("ws.enabled") : t("ws.disabled")}
          />
        )}
        <span className="text-xs text-muted">
          {enabled === undefined ? "" : enabled ? t("ws.enabled") : t("ws.disabled")}
        </span>
        <span className="ml-auto truncate text-[11px] text-muted/70">
          {updatedAt && t("ws.updatedAt", { time: timeAgo(updatedAt) })}
        </span>
        {extraActions}
        {onEdit && (
          <button
            onClick={onEdit}
            className="no-drag rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-text"
            title={t("ws.edit")}
            aria-label={t("ws.edit")}
          >
            <Edit3 className="h-4 w-4" />
          </button>
        )}
        {onDelete && (
          <button
            onClick={() => {
              if (confirming) {
                onDelete();
                setConfirming(false);
              } else {
                setConfirming(true);
                window.setTimeout(() => setConfirming(false), 3000);
              }
            }}
            className={cn(
              "no-drag rounded-lg p-1.5 transition-colors",
              confirming
                ? "bg-danger/15 text-danger"
                : "text-muted hover:bg-surface-2 hover:text-danger",
            )}
            title={confirming ? t("ws.confirmDelete") : t("ws.delete")}
            aria-label={confirming ? t("ws.confirmDelete") : t("ws.delete")}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </footer>
    </article>
  );
}

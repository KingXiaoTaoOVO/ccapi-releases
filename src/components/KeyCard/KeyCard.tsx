import { useEffect, useState } from "react";
import {
  Check,
  Copy,
  Gauge,
  Pencil,
  Power,
  RefreshCw,
  Timer,
  Trash2,
  Zap,
} from "lucide-react";
import type { ApiKey } from "@/types";
import { cn } from "@/lib/cn";
import { maskKey, timeAgo, cooldownRemaining, formatDuration } from "@/lib/format";
import { StatusBadge } from "@/components/StatusBadge/StatusBadge";
import { Switch } from "@/components/ui/Switch";
import { useGSAPHover } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { useAppStore } from "@/store/useAppStore";
import { toast } from "@/store/useToastStore";

interface KeyCardProps {
  apiKey: ApiKey;
  onEdit: (key: ApiKey) => void;
  /** When true the card becomes a selectable item for batch operations. */
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
}

export function KeyCard({ apiKey, onEdit, selectMode, selected, onToggleSelect }: KeyCardProps) {
  const t = useT();
  const isActive = useAppStore((s) => s.activeKeyId === apiKey.id);
  const checking = useAppStore((s) => !!s.checking[apiKey.id]);
  const setActiveKey = useAppStore((s) => s.setActiveKey);
  const toggleKey = useAppStore((s) => s.toggleKey);
  const removeKey = useAppStore((s) => s.removeKey);
  const checkKey = useAppStore((s) => s.checkKey);

  const hoverRef = useGSAPHover<HTMLDivElement>({ y: -4 });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);
  const [, force] = useState(0);

  const cooling = apiKey.status === "cooling" && cooldownRemaining(apiKey.cooldownUntil) > 0;

  // Tick once a second while cooling so the countdown stays live.
  useEffect(() => {
    if (!cooling) return;
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [cooling]);

  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(apiKey.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t("card.copyFailed"));
    }
  };

  const pct = apiKey.quotaRemainingPct;
  const pctColor =
    pct === undefined
      ? "bg-muted/40"
      : pct <= 10
        ? "bg-danger"
        : pct <= 30
          ? "bg-warning"
          : "bg-primary";

  return (
    <div
      data-anim
      ref={hoverRef}
      onMouseMove={(e) => {
        const el = e.currentTarget;
        const r = el.getBoundingClientRect();
        el.style.setProperty("--mx", `${e.clientX - r.left}px`);
        el.style.setProperty("--my", `${e.clientY - r.top}px`);
      }}
      className={cn(
        "glass-soft spotlight relative p-5 will-change-transform",
        isActive && "ring-2 ring-primary/60 shadow-glow",
        selectMode && "cursor-pointer",
        selected && "ring-2 ring-primary shadow-glow",
        !apiKey.enabled && "opacity-60",
      )}
    >
      {/* selection overlay — captures clicks so card actions don't fire in select mode */}
      {selectMode && (
        <button
          type="button"
          aria-pressed={selected}
          aria-label={apiKey.name}
          onClick={() => onToggleSelect?.(apiKey.id)}
          className="absolute inset-0 z-20 rounded-2xl"
        />
      )}

      {isActive && (
        <span className="absolute -top-2.5 left-5 inline-flex items-center gap-1 rounded-full bg-primary px-2.5 py-0.5 text-[11px] font-semibold text-white dark:text-[#04221d] shadow-soft">
          <Zap className="h-3 w-3" /> {t("card.active")}
        </span>
      )}

      {/* header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          {selectMode && (
            <span
              className={cn(
                "pointer-events-none mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border transition-colors",
                selected
                  ? "border-primary bg-primary text-white dark:text-[#04221d]"
                  : "border-border bg-surface",
              )}
            >
              {selected && <Check className="h-3.5 w-3.5" />}
            </span>
          )}
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold">{apiKey.name}</h3>
            <div className="mt-1 flex items-center gap-2">
              <code className="font-mono text-xs text-muted">{maskKey(apiKey.key)}</code>
              <button
                onClick={copyKey}
                className="text-muted hover:text-primary transition-colors"
                title={t("card.copyFull")}
              >
                {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
        </div>
        <StatusBadge status={apiKey.status} />
      </div>

      {/* quota */}
      {(pct !== undefined || apiKey.quotaRemainingUsd != null) && (
        <div className="mt-4">
          <div className="mb-1 flex items-center justify-between text-xs text-muted">
            <span className="inline-flex items-center gap-1">
              <Gauge className="h-3.5 w-3.5" /> {t("card.remaining")}
            </span>
            <span className="font-medium text-text">
              {apiKey.quotaRemainingUsd != null
                ? `$${apiKey.quotaRemainingUsd.toFixed(2)}${
                    apiKey.quotaLimit != null ? ` / $${apiKey.quotaLimit.toFixed(2)}` : ""
                  }`
                : `${pct}%`}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
            <div
              className={cn("h-full rounded-full transition-all duration-500", pctColor)}
              style={{ width: `${pct ?? 100}%` }}
            />
          </div>
        </div>
      )}

      {/* meta */}
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        {cooling ? (
          <span className="inline-flex items-center gap-1 text-info">
            <Timer className="h-3.5 w-3.5" />
            {t("card.cooldownLeft", { time: formatDuration(cooldownRemaining(apiKey.cooldownUntil)) })}
          </span>
        ) : (
          typeof apiKey.latencyMs === "number" && (
            <span className="inline-flex items-center gap-1">
              <Zap className="h-3.5 w-3.5" />
              {apiKey.latencyMs} ms
            </span>
          )
        )}
        <span>{t("card.checkedAt", { time: timeAgo(apiKey.lastCheckedAt) })}</span>
        {apiKey.note && <span className="truncate">· {apiKey.note}</span>}
      </div>

      {/* actions */}
      <div className="mt-4 flex items-center justify-between border-t border-border/70 pt-3">
        <div className="flex items-center gap-2">
          <Switch
            checked={apiKey.enabled}
            onChange={() => toggleKey(apiKey.id)}
            label={t("common.enable")}
          />
          <span className="text-xs text-muted">
            {apiKey.enabled ? t("common.enabled") : t("common.disabled")}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <IconBtn
            title={t("card.checkNow")}
            onClick={() => checkKey(apiKey.id)}
            disabled={!apiKey.enabled}
          >
            <RefreshCw className={cn("h-4 w-4", checking && "animate-spin")} />
          </IconBtn>
          {!isActive && (
            <IconBtn
              title={t("card.setActive")}
              onClick={() => setActiveKey(apiKey.id)}
              disabled={!apiKey.enabled}
              accent
            >
              <Power className="h-4 w-4" />
            </IconBtn>
          )}
          <IconBtn title={t("card.edit")} onClick={() => onEdit(apiKey)}>
            <Pencil className="h-4 w-4" />
          </IconBtn>
          {confirmDelete ? (
            <button
              onClick={() => removeKey(apiKey.id)}
              onMouseLeave={() => setConfirmDelete(false)}
              className="rounded-lg bg-danger/15 px-2 py-1 text-xs font-medium text-danger hover:bg-danger/25"
            >
              {t("card.confirmDelete")}
            </button>
          ) : (
            <IconBtn title={t("card.delete")} onClick={() => setConfirmDelete(true)} danger>
              <Trash2 className="h-4 w-4" />
            </IconBtn>
          )}
        </div>
      </div>
    </div>
  );
}

function IconBtn({
  children,
  onClick,
  title,
  disabled,
  accent,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  disabled?: boolean;
  accent?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={cn(
        "rounded-lg p-1.5 transition-colors disabled:opacity-40 disabled:pointer-events-none",
        accent
          ? "text-primary hover:bg-primary/10"
          : danger
            ? "text-muted hover:bg-danger/10 hover:text-danger"
            : "text-muted hover:bg-surface-2 hover:text-text",
      )}
    >
      {children}
    </button>
  );
}

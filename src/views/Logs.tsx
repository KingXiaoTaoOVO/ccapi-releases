import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CircleAlert,
  Copy,
  FileText,
  Info,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { WorkspacePage } from "@/components/workspace/WorkspacePage";
import { EmptyState } from "@/components/workspace/EmptyState";
import { useT } from "@/i18n";
import type { LogEntry, LogLevel } from "@/types";
import type { MessageKey } from "@/i18n/messages";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import { toast } from "@/store/useToastStore";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/format";

const LEVEL_LABEL: Record<LogLevel, MessageKey> = {
  info: "logs.level.info",
  warning: "logs.level.warning",
  error: "logs.level.error",
};

const LEVEL_TONE: Record<LogLevel, string> = {
  info: "bg-info/15 text-info border-info/30",
  warning: "bg-warning/15 text-warning border-warning/30",
  error: "bg-danger/15 text-danger border-danger/30",
};

const LEVEL_ICON: Record<LogLevel, typeof Info> = {
  info: Info,
  warning: AlertTriangle,
  error: CircleAlert,
};

const FILTERS: { value: "all" | LogLevel; labelKey: MessageKey }[] = [
  { value: "all", labelKey: "logs.filter.all" },
  { value: "info", labelKey: "logs.level.info" },
  { value: "warning", labelKey: "logs.level.warning" },
  { value: "error", labelKey: "logs.level.error" },
];

function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return Promise.reject(new Error("Clipboard API unavailable"));
}

function formatEntry(e: LogEntry): string {
  const base = `[${e.createdAt}] ${e.level.toUpperCase()} ${e.source} — ${e.message}`;
  return e.detail ? `${base}\n${e.detail}` : base;
}

export function Logs() {
  const t = useT();
  const logs = useWorkspaceStore((s) => s.logs);
  const removeLog = useWorkspaceStore((s) => s.removeLog);
  const clearLogs = useWorkspaceStore((s) => s.clearLogs);

  const [filter, setFilter] = useState<"all" | LogLevel>("all");
  const [query, setQuery] = useState("");
  const [confirming, setConfirming] = useState(false);

  const counts = useMemo(() => {
    const acc: Record<string, number> = { all: logs.length };
    for (const log of logs) {
      acc[log.level] = (acc[log.level] ?? 0) + 1;
    }
    return acc;
  }, [logs]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return logs.filter((log) => {
      if (filter !== "all" && log.level !== filter) return false;
      if (!q) return true;
      return [log.message, log.source, log.detail ?? ""].some((s) =>
        s.toLowerCase().includes(q),
      );
    });
  }, [logs, filter, query]);

  const handleClear = () => {
    if (!confirming) {
      setConfirming(true);
      window.setTimeout(() => setConfirming(false), 3000);
      return;
    }
    clearLogs();
    setConfirming(false);
  };

  const exportAll = async () => {
    try {
      await copyToClipboard(logs.map(formatEntry).join("\n\n"));
      toast.success(t("logs.exported"));
    } catch {
      toast.error(t("ws.copyFailed"));
    }
  };

  return (
    <WorkspacePage
      search={{ value: query, onChange: setQuery }}
      toolbarExtra={
        <>
          <div className="flex flex-wrap items-center gap-1 rounded-xl border border-border bg-surface-2/60 p-1">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setFilter(f.value)}
                className={cn(
                  "no-drag rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                  filter === f.value
                    ? "bg-primary/15 text-primary"
                    : "text-muted hover:text-text",
                )}
              >
                {t(f.labelKey)} {counts[f.value] ? `· ${counts[f.value]}` : ""}
              </button>
            ))}
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={exportAll}
            disabled={logs.length === 0}
          >
            <Copy className="h-3.5 w-3.5" />
            {t("logs.copy")}
          </Button>
          <Button
            size="sm"
            variant={confirming ? "danger" : "ghost"}
            onClick={handleClear}
            disabled={logs.length === 0}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {confirming ? t("logs.clearConfirm") : t("logs.clear")}
          </Button>
        </>
      }
    >
      {filtered.length === 0 ? (
        <EmptyState
          icon={FileText}
          title={logs.length === 0 ? t("logs.empty") : t("dash.noMatch")}
          hint={logs.length === 0 ? t("logs.emptyHint") : undefined}
        />
      ) : (
        <ul className="space-y-2.5">
          {filtered.map((log) => {
            const Icon = LEVEL_ICON[log.level];
            return (
              <li
                key={log.id}
                className={cn(
                  "flex items-start gap-3 rounded-xl border bg-surface/50 p-3 shadow-soft backdrop-blur-md",
                  LEVEL_TONE[log.level],
                )}
              >
                <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-semibold">{t(LEVEL_LABEL[log.level])}</span>
                    <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] uppercase text-muted">
                      {log.source}
                    </span>
                    <span className="ml-auto text-[11px] text-muted">
                      {formatDateTime(log.createdAt)}
                    </span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-text">
                    {log.message}
                  </p>
                  {log.detail && (
                    <pre className="mt-2 max-h-32 overflow-y-auto rounded-lg bg-surface-2/60 p-2 font-mono text-[11px] leading-relaxed text-muted">
                      {log.detail}
                    </pre>
                  )}
                </div>
                <button
                  onClick={() => removeLog(log.id)}
                  className="no-drag shrink-0 rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-danger"
                  title={t("ws.delete")}
                  aria-label={t("ws.delete")}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </WorkspacePage>
  );
}

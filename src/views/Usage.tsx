import { useMemo, useState } from "react";
import {
  ArrowDownAZ,
  ArrowDownWideNarrow,
  KeyRound,
  RefreshCw,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { WorkspacePage } from "@/components/workspace/WorkspacePage";
import { EmptyState } from "@/components/workspace/EmptyState";
import { StatusBadge } from "@/components/StatusBadge/StatusBadge";
import { useT } from "@/i18n";
import { useAppStore } from "@/store/useAppStore";
import type { ApiKey, KeyStatus } from "@/types";
import { cn } from "@/lib/cn";
import { maskKey, timeAgo } from "@/lib/format";

type SortKey = "name" | "usage" | "remaining";

function formatUsd(value?: number): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  if (value >= 1000) return `$${value.toFixed(0)}`;
  return `$${value.toFixed(2)}`;
}

function StatTile({
  label,
  value,
  hint,
  icon: Icon,
  tone = "primary",
}: {
  label: string;
  value: string;
  hint?: string;
  icon: typeof Wallet;
  tone?: "primary" | "success" | "warning" | "info";
}) {
  const toneClass: Record<typeof tone, string> = {
    primary: "text-primary bg-primary/10",
    success: "text-success bg-success/10",
    warning: "text-warning bg-warning/10",
    info: "text-info bg-info/10",
  };
  return (
    <div className="rounded-2xl border border-border bg-surface/60 p-4 shadow-soft backdrop-blur-md">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "grid h-10 w-10 shrink-0 place-items-center rounded-xl",
            toneClass[tone],
          )}
        >
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="text-xs text-muted">{label}</p>
          <p className="truncate text-xl font-semibold tabular-nums">{value}</p>
          {hint && <p className="mt-0.5 truncate text-[11px] text-muted/80">{hint}</p>}
        </div>
      </div>
    </div>
  );
}

function UsageBar({ pct }: { pct: number }) {
  const safe = Math.max(0, Math.min(100, pct));
  const tone =
    safe >= 60 ? "bg-success" : safe >= 20 ? "bg-warning" : "bg-danger";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
      <div
        className={cn("h-full transition-all duration-300", tone)}
        style={{ width: `${safe}%` }}
      />
    </div>
  );
}

export function Usage() {
  const t = useT();
  const keys = useAppStore((s) => s.keys);
  const stats = useAppStore((s) => s.proxyStats);
  const bulkChecking = useAppStore((s) => s.bulkChecking);
  const checkAll = useAppStore((s) => s.checkAll);

  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("usage");

  const aggregate = useMemo(() => {
    let totalLimit = 0;
    let totalUsed = 0;
    let totalRemaining = 0;
    let withQuota = 0;
    for (const k of keys) {
      if (typeof k.quotaLimit === "number") {
        totalLimit += k.quotaLimit;
        withQuota += 1;
      }
      if (typeof k.quotaUsed === "number") totalUsed += k.quotaUsed;
      if (typeof k.quotaRemainingUsd === "number") {
        totalRemaining += k.quotaRemainingUsd;
      }
    }
    return { totalLimit, totalUsed, totalRemaining, withQuota };
  }, [keys]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = keys.filter((k) => {
      if (!q) return true;
      return (
        k.name.toLowerCase().includes(q) ||
        k.note?.toLowerCase().includes(q) ||
        k.key.toLowerCase().includes(q)
      );
    });
    const sorted = [...filtered].sort((a, b) => {
      if (sortBy === "name") return a.name.localeCompare(b.name);
      if (sortBy === "usage") {
        const ua = a.quotaUsed ?? -1;
        const ub = b.quotaUsed ?? -1;
        return ub - ua;
      }
      const ra = a.quotaRemainingUsd ?? -Infinity;
      const rb = b.quotaRemainingUsd ?? -Infinity;
      return rb - ra;
    });
    return sorted;
  }, [keys, query, sortBy]);

  const hasQuota = aggregate.withQuota > 0;

  return (
    <WorkspacePage
      search={{ value: query, onChange: setQuery }}
      toolbarExtra={
        <>
          <div className="flex items-center gap-1 rounded-xl border border-border bg-surface-2/60 p-1">
            {(
              [
                { value: "name", label: t("usage.sortByName"), icon: ArrowDownAZ },
                { value: "usage", label: t("usage.sortByUsage"), icon: ArrowDownWideNarrow },
                { value: "remaining", label: t("usage.sortByRemaining"), icon: Wallet },
              ] as { value: SortKey; label: string; icon: typeof ArrowDownAZ }[]
            ).map((opt) => {
              const Icon = opt.icon;
              return (
                <button
                  key={opt.value}
                  onClick={() => setSortBy(opt.value)}
                  className={cn(
                    "no-drag flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                    sortBy === opt.value
                      ? "bg-primary/15 text-primary"
                      : "text-muted hover:text-text",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {opt.label}
                </button>
              );
            })}
          </div>
        </>
      }
      primaryAction={{
        label: t("usage.refresh"),
        onClick: () => checkAll(),
        icon: RefreshCw,
      }}
    >
      {keys.length === 0 ? (
        <EmptyState
          icon={Wallet}
          title={t("usage.empty")}
          hint={t("usage.emptyHint")}
        />
      ) : (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label={t("usage.totalKeys")}
              value={String(keys.length)}
              hint={t("usage.coverage") + ` · ${aggregate.withQuota}`}
              icon={KeyRound}
            />
            <StatTile
              label={t("usage.totalQuota")}
              value={hasQuota ? formatUsd(aggregate.totalLimit) : "—"}
              icon={Wallet}
              tone="info"
            />
            <StatTile
              label={t("usage.totalUsed")}
              value={hasQuota ? formatUsd(aggregate.totalUsed) : "—"}
              icon={TrendingUp}
              tone="warning"
            />
            <StatTile
              label={t("usage.totalRemaining")}
              value={hasQuota ? formatUsd(aggregate.totalRemaining) : "—"}
              hint={
                stats.currentHitName
                  ? `${t("usage.currentHit")}: ${stats.currentHitName}`
                  : `${t("usage.totalForwarded")}: ${stats.totalForwarded}`
              }
              icon={Wallet}
              tone="success"
            />
          </div>

          {!hasQuota && (
            <p className="rounded-xl border border-dashed border-border bg-surface-2/40 px-4 py-3 text-xs text-muted">
              {t("usage.noQuotaData")}
            </p>
          )}

          <div className="overflow-hidden rounded-2xl border border-border bg-surface/50 shadow-soft backdrop-blur-md">
            <table className="w-full text-sm">
              <thead className="bg-surface-2/60 text-xs text-muted">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">
                    {t("usage.column.name")}
                  </th>
                  <th className="px-3 py-3 text-left font-medium">
                    {t("usage.column.status")}
                  </th>
                  <th className="px-3 py-3 text-right font-medium">
                    {t("usage.column.usage")}
                  </th>
                  <th className="px-3 py-3 text-right font-medium">
                    {t("usage.column.remaining")}
                  </th>
                  <th className="px-3 py-3 text-left font-medium">
                    {t("usage.column.percent")}
                  </th>
                  <th className="px-3 py-3 text-right font-medium">
                    {t("usage.column.latency")}
                  </th>
                  <th className="px-4 py-3 text-right font-medium">
                    {t("usage.column.lastCheck")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {rows.map((k: ApiKey) => {
                  const pct = k.quotaRemainingPct;
                  const used = k.quotaUsed;
                  const limit = k.quotaLimit;
                  return (
                    <tr key={k.id} className="hover:bg-surface-2/40">
                      <td className="px-4 py-3">
                        <div className="font-medium">{k.name}</div>
                        <div className="font-mono text-[11px] text-muted/80">
                          {maskKey(k.key)}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <StatusBadge status={k.status as KeyStatus} size="sm" />
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        {typeof used === "number" && typeof limit === "number"
                          ? `${formatUsd(used)} / ${formatUsd(limit)}`
                          : "—"}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        {formatUsd(k.quotaRemainingUsd)}
                      </td>
                      <td className="px-3 py-3">
                        {typeof pct === "number" ? (
                          <div className="flex items-center gap-2">
                            <UsageBar pct={pct} />
                            <span className="w-10 text-right text-xs tabular-nums text-muted">
                              {pct.toFixed(0)}%
                            </span>
                          </div>
                        ) : (
                          <span className="text-xs text-muted">—</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        {typeof k.latencyMs === "number"
                          ? `${k.latencyMs} ms`
                          : "—"}
                      </td>
                      <td className="px-4 py-3 text-right text-xs text-muted">
                        {timeAgo(k.lastCheckedAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {bulkChecking && (
            <p className="text-center text-xs text-muted">…</p>
          )}
        </div>
      )}
    </WorkspacePage>
  );
}

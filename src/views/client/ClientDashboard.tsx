import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, CalendarCheck, Crown, Gift, Sparkles, Wallet, Zap } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { apiPost } from "@/services/apiClient";
import { notify } from "@/services/notify";
import type { EChartsOption } from "echarts";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { apiGet } from "@/services/apiClient";
import { Chart } from "@/components/charts/Chart";
import { ProxySourceCard } from "@/components/ProxySourceCard/ProxySourceCard";

interface QuotaSnapshot {
  bonusRemainingUsd: string;
  baseRemainingUsd: string;
  totalConsumedUsd: string;
  tier: string | null;
  tierExpiresAt: string | null;
  window5h: WindowState;
  window7d: WindowState;
}

interface WindowState {
  limitUsd: number;
  usedUsd: number;
  remainingUsd: number;
  usedPct: number;
  resetAt: string | null;
  resetInSecs: number;
}

interface UsageLog {
  id: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: string;
  pool: string;
  latencyMs?: number;
  requestId: string | null;
  createdAt: string | null;
}

interface PendingInvite {
  id: number;
  rewardInviterUsd: string;
  inviteeId: number;
  createdAt: string | null;
}

interface CheckinState {
  checkedToday: boolean;
  streak: number;
  lastRewardUsd: number;
}

export function ClientDashboard() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 12 });
  const [q, setQ] = useState<QuotaSnapshot | null>(null);
  const [tierName, setTierName] = useState<string | null>(null);
  const [logs, setLogs] = useState<UsageLog[]>([]);
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [checkin, setCheckin] = useState<CheckinState | null>(null);

  const load = useCallback(async () => {
    try {
      const [data, lg, inv, ci] = await Promise.all([
        apiGet<QuotaSnapshot>("/api/user/me/quota"),
        apiGet<{ logs: UsageLog[] }>("/api/user/me/usage?limit=500").catch(() => ({
          logs: [] as UsageLog[],
        })),
        apiGet<{ invitations: PendingInvite[] }>("/api/user/me/invitations").catch(
          () => ({ invitations: [] as PendingInvite[] }),
        ),
        apiGet<CheckinState>("/api/me/checkin").catch(() => null),
      ]);
      setQ(data);
      setLogs(lg.logs);
      setPendingInvites(inv.invitations);
      if (ci) setCheckin(ci);
      if (data.tier) {
        const tiers = await apiGet<{ tiers: { code: string; displayName: string }[] }>(
          "/api/tiers",
        );
        const t = tiers.tiers.find((x) => x.code === data.tier);
        setTierName(t?.displayName ?? data.tier);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(load, 30_000);
    return () => window.clearInterval(id);
  }, [load]);

  // 把最近 30 天的日志聚合成 day -> { input, output, calls }
  const daily = useMemo(() => buildDaily(logs, 30), [logs]);
  const modelTop = useMemo(() => buildModelTop(logs, 8), [logs]);
  // 24h 平均响应耗时
  const avgLatency24h = useMemo(() => {
    const cutoff = Date.now() - 86_400_000;
    const recent = logs.filter((l) => {
      const ts = l.createdAt ? new Date(l.createdAt + "Z").getTime() : 0;
      return ts > cutoff && (l.latencyMs ?? 0) > 0;
    });
    if (recent.length === 0) return 0;
    return Math.round(recent.reduce((a, r) => a + (r.latencyMs ?? 0), 0) / recent.length);
  }, [logs]);
  // 配额告警
  const lowQuota = useMemo(() => {
    if (!q) return false;
    const w5 = q.window5h;
    const w7 = q.window7d;
    return (
      (w5.limitUsd > 0 && w5.usedPct >= 80) ||
      (w7.limitUsd > 0 && w7.usedPct >= 80)
    );
  }, [q]);
  // 续费倒计时
  const renewCountdown = useMemo(() => {
    if (!q?.tierExpiresAt) return null;
    const ms = new Date(q.tierExpiresAt + "Z").getTime() - Date.now();
    if (ms <= 0) return { expired: true, days: 0 };
    const days = Math.ceil(ms / 86_400_000);
    return { expired: false, days };
  }, [q]);

  if (!q) {
    return (
      <div className="grid h-full place-items-center text-xs text-muted">
        {t("common.loading")}
      </div>
    );
  }

  return (
    <div ref={ref} className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <header>
          <h1 className="text-xl font-semibold">{t("client.dash.title")}</h1>
          <p className="mt-1 text-sm text-muted">{t("client.dash.subtitle")}</p>
        </header>

        <ProxySourceCard />

        {/* 每日签到 */}
        {checkin && (
          <div className="flex items-center gap-4 rounded-2xl border border-border bg-surface/60 p-4 backdrop-blur-xl">
            <CalendarCheck className="h-6 w-6 text-primary" />
            <div className="flex-1">
              <p className="text-sm font-medium">{t("checkin.title")}</p>
              <p className="text-xs text-muted">
                {checkin.checkedToday
                  ? t("checkin.done", {
                      streak: String(checkin.streak),
                      reward: checkin.lastRewardUsd.toFixed(2),
                    })
                  : t("checkin.streakInfo", { n: String(checkin.streak) })}
              </p>
            </div>
            <Button
              size="sm"
              disabled={checkin.checkedToday}
              onClick={async () => {
                try {
                  const r = await apiPost<{
                    streak: number;
                    rewardUsd: number;
                  }>("/api/me/checkin", {});
                  notify(
                    "success",
                    t("checkin.gotReward", {
                      reward: r.rewardUsd.toFixed(2),
                      streak: String(r.streak),
                    }),
                  );
                  setCheckin({
                    checkedToday: true,
                    streak: r.streak,
                    lastRewardUsd: r.rewardUsd,
                  });
                  void load();
                } catch (e: any) {
                  notify("error", t("checkin.fail"), e?.message);
                }
              }}
            >
              {checkin.checkedToday ? t("checkin.doneBtn") : t("checkin.btn")}
            </Button>
          </div>
        )}

        {/* 提醒卡片 */}
        {(lowQuota || pendingInvites.length > 0 || renewCountdown?.expired ||
          (renewCountdown && renewCountdown.days <= 3)) && (
          <div className="space-y-2">
            {lowQuota && (
              <div className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2.5 text-warning">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p className="text-xs leading-relaxed">{t("client.dash.alert.lowQuota")}</p>
              </div>
            )}
            {renewCountdown?.expired && (
              <div className="flex items-start gap-3 rounded-xl border border-danger/40 bg-danger/10 px-3 py-2.5 text-danger">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p className="text-xs leading-relaxed">{t("client.dash.alert.expired")}</p>
              </div>
            )}
            {renewCountdown && !renewCountdown.expired && renewCountdown.days <= 3 && (
              <div className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2.5 text-warning">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p className="text-xs leading-relaxed">
                  {t("client.dash.alert.renewSoon", { days: String(renewCountdown.days) })}
                </p>
              </div>
            )}
            {pendingInvites.length > 0 && (
              <div className="flex items-start gap-3 rounded-xl border border-info/40 bg-info/10 px-3 py-2.5 text-info">
                <Gift className="mt-0.5 h-4 w-4 shrink-0" />
                <p className="text-xs leading-relaxed">
                  {t("client.dash.alert.pendingInvites", {
                    n: String(pendingInvites.length),
                  })}
                </p>
              </div>
            )}
          </div>
        )}

        {/* avg latency 24h 卡片 */}
        <div className="rounded-2xl border border-border bg-surface/60 p-4 backdrop-blur-xl">
          <div className="flex items-center gap-2 text-xs text-muted">
            <Zap className="h-4 w-4 text-info" />
            {t("client.dash.avgLatency24h")}
          </div>
          <div className="mt-1 text-lg font-semibold tabular-nums">
            {avgLatency24h > 0 ? `${avgLatency24h} ms` : "—"}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <WindowCard
            label={t("client.dash.window5h")}
            window={q.window5h}
            description={t("client.dash.window5hHint")}
          />
          <WindowCard
            label={t("client.dash.window7d")}
            window={q.window7d}
            description={t("client.dash.window7dHint")}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <BalanceCard
            icon={Sparkles}
            label={t("client.dash.bonus")}
            value={`$${Number(q.bonusRemainingUsd).toFixed(2)}`}
            hint={t("client.dash.bonusHint")}
            accent="text-info"
          />
          <BalanceCard
            icon={Wallet}
            label={t("client.dash.base")}
            value={`$${Number(q.baseRemainingUsd).toFixed(2)}`}
            hint={t("client.dash.baseHint")}
            accent="text-primary"
          />
          <BalanceCard
            icon={Crown}
            label={t("client.dash.tier")}
            value={tierName ?? t("client.dash.noTier")}
            hint={
              q.tierExpiresAt
                ? t("client.dash.tierExp", {
                    date: new Date(q.tierExpiresAt + "Z").toLocaleString(),
                  })
                : t("client.dash.tierFree")
            }
            accent="text-warning"
          />
        </div>

        <div className="rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-success" />
            <span className="text-sm font-semibold">
              {t("client.dash.consumed")}
            </span>
          </div>
          <p className="mt-2 text-2xl font-semibold tabular-nums">
            ${Number(q.totalConsumedUsd).toFixed(4)}
          </p>
          <p className="mt-1 text-xs text-muted">{t("client.dash.consumedHint")}</p>
        </div>

        {/* 30 天 token / 模型分布 */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="rounded-2xl border border-border bg-surface/60 p-4 backdrop-blur-xl lg:col-span-2">
            <p className="mb-2 text-xs font-semibold text-muted">
              {t("client.dash.chartTokens")}
            </p>
            <div className="h-56">
              {daily.length === 0 ? (
                <div className="grid h-full place-items-center text-xs text-muted">
                  {t("client.dash.noData")}
                </div>
              ) : (
                <Chart
                  option={userTokenOption(
                    daily,
                    t("client.dash.legend.input"),
                    t("client.dash.legend.output"),
                  )}
                />
              )}
            </div>
          </div>
          <div className="rounded-2xl border border-border bg-surface/60 p-4 backdrop-blur-xl">
            <p className="mb-2 text-xs font-semibold text-muted">
              {t("client.dash.chartModels")}
            </p>
            <div className="h-56">
              {modelTop.length === 0 ? (
                <div className="grid h-full place-items-center text-xs text-muted">
                  {t("client.dash.noData")}
                </div>
              ) : (
                <Chart option={userModelPieOption(modelTop)} />
              )}
            </div>
          </div>
        </div>

        {/* 最近 20 次调用 */}
        <div className="rounded-2xl border border-border bg-surface/60 p-4 backdrop-blur-xl">
          <p className="mb-2 text-xs font-semibold text-muted">
            {t("client.dash.recent")}
          </p>
          {logs.length === 0 ? (
            <div className="grid place-items-center py-8 text-xs text-muted">
              {t("client.dash.noData")}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium">
                      {t("client.dash.col.time")}
                    </th>
                    <th className="px-2 py-1.5 text-left font-medium">
                      {t("client.dash.col.model")}
                    </th>
                    <th className="px-2 py-1.5 text-right font-medium">
                      {t("client.dash.col.input")}
                    </th>
                    <th className="px-2 py-1.5 text-right font-medium">
                      {t("client.dash.col.output")}
                    </th>
                    <th className="px-2 py-1.5 text-right font-medium">
                      {t("client.dash.col.cost")}
                    </th>
                    <th className="px-2 py-1.5 text-left font-medium">
                      {t("client.dash.col.pool")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {logs.slice(0, 20).map((r) => (
                    <tr key={r.id} className="border-t border-border/40">
                      <td className="px-2 py-1.5">
                        {r.createdAt
                          ? new Date(r.createdAt + "Z").toLocaleString()
                          : "—"}
                      </td>
                      <td className="px-2 py-1.5 font-mono">{r.model}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {r.inputTokens.toLocaleString()}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {r.outputTokens.toLocaleString()}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        ${Number(r.costUsd).toFixed(4)}
                      </td>
                      <td className="px-2 py-1.5">{r.pool}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// 聚合到天（YYYY-MM-DD）
function buildDaily(logs: UsageLog[], days: number) {
  const map = new Map<string, { input: number; output: number; calls: number }>();
  const now = Date.now();
  const cutoff = now - days * 86400 * 1000;
  for (const l of logs) {
    if (!l.createdAt) continue;
    const ts = Date.parse(l.createdAt + "Z");
    if (Number.isNaN(ts) || ts < cutoff) continue;
    const day = new Date(ts).toISOString().slice(0, 10);
    const cur = map.get(day) ?? { input: 0, output: 0, calls: 0 };
    cur.input += l.inputTokens;
    cur.output += l.outputTokens;
    cur.calls += 1;
    map.set(day, cur);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, v]) => ({ day, ...v }));
}

function buildModelTop(logs: UsageLog[], n: number) {
  const map = new Map<string, number>();
  for (const l of logs) {
    map.set(l.model, (map.get(l.model) ?? 0) + l.inputTokens + l.outputTokens);
  }
  return Array.from(map.entries())
    .sort(([, a], [, b]) => b - a)
    .slice(0, n)
    .map(([model, tokens]) => ({ model, tokens }));
}

function userTokenOption(
  rows: { day: string; input: number; output: number }[],
  inputLabel: string,
  outputLabel: string,
): EChartsOption {
  return {
    tooltip: { trigger: "axis" },
    legend: { data: [inputLabel, outputLabel], top: 0 },
    xAxis: { type: "category", data: rows.map((r) => r.day) },
    yAxis: { type: "value" },
    series: [
      {
        name: inputLabel,
        type: "line",
        smooth: true,
        showSymbol: false,
        data: rows.map((r) => r.input),
      },
      {
        name: outputLabel,
        type: "line",
        smooth: true,
        showSymbol: false,
        data: rows.map((r) => r.output),
      },
    ],
  };
}

function userModelPieOption(
  rows: { model: string; tokens: number }[],
): EChartsOption {
  return {
    tooltip: { trigger: "item" },
    legend: { show: false },
    series: [
      {
        type: "pie",
        radius: ["45%", "70%"],
        avoidLabelOverlap: true,
        itemStyle: { borderRadius: 4 },
        label: { fontSize: 11 },
        data: rows.map((r) => ({
          name: r.model.split("-").slice(-2).join("-"),
          value: r.tokens,
        })),
      },
    ],
  };
}

function WindowCard({
  label,
  description,
  window: w,
}: {
  label: string;
  description: string;
  window: WindowState;
}) {
  const pct = Math.min(100, Math.max(0, w.usedPct));
  const remaining = formatHms(w.resetInSecs);
  return (
    <div className="rounded-2xl border border-border bg-surface/60 p-5 shadow-soft backdrop-blur-xl">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">
        ${w.usedUsd.toFixed(2)} <span className="text-sm text-muted">/ ${w.limitUsd.toFixed(2)}</span>
      </p>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full rounded-full bg-primary transition-[width]"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-2 text-[11px] text-muted">{description.replace("{when}", remaining)}</p>
    </div>
  );
}

function BalanceCard({
  icon: Icon,
  label,
  value,
  hint,
  accent,
}: {
  icon: typeof Sparkles;
  label: string;
  value: string;
  hint: string;
  accent: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface/60 p-5 shadow-soft backdrop-blur-xl">
      <div className="flex items-center gap-2 text-xs text-muted">
        <Icon className={`h-4 w-4 ${accent}`} />
        {label}
      </div>
      <p className="mt-2 text-xl font-semibold tabular-nums">{value}</p>
      <p className="mt-1 text-[11px] text-muted">{hint}</p>
    </div>
  );
}

function formatHms(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return `${h}h ${m}m`;
}

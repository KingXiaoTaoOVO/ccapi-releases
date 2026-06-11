import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  Coins,
  Cpu,
  Database,
  ExternalLink,
  HardDrive,
  Network,
  RefreshCw,
  ServerCog,
  Users,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { EChartsOption } from "echarts";
import { Chart } from "@/components/charts/Chart";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { adminServerStatus, openClientWindow } from "@/services/tauri";
import { apiGet } from "@/services/apiClient";
import { useAuthStore } from "@/store/useAuthStore";
import { useThemeStore } from "@/store/useThemeStore";
import { notify } from "@/services/notify";
import type { ServerStatus } from "@/types/auth";

interface Overview {
  usersTotal: number;
  usersNewToday: number;
  callsToday: number;
  tokensToday: number;
  costTodayUsd: string;
  cost7dUsd: string;
  cost30dUsd: string;
  channelsTotal: number;
  channelsEnabled: number;
  channelsFailing: number;
  invitationsTotal: number;
}
interface DailyPoint {
  day: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: string;
}
interface TopUser {
  id: number;
  username: string;
  calls: number;
  tokens: number;
  costUsd: string;
}
interface TopModel {
  model: string;
  calls: number;
  tokens: number;
  costUsd: string;
}
interface QpsPoint {
  bucket: string;
  calls: number;
}
interface SystemStatus {
  cpuPct: number;
  memUsedBytes: number;
  memTotalBytes: number;
  memUsedPct: number;
  redisClients: number;
}
interface Activity {
  dau: number;
  wau: number;
  mau: number;
  online: number;
}
interface PerfData {
  globalP50: number;
  globalP95: number;
  globalP99: number;
  perChannel: { channelId: number | null; name: string | null; calls: number; avgMs: number; maxMs: number }[];
}
interface GroupSpend {
  groupId: number | null;
  name: string;
  costUsd: string;
}
interface FailingChannel {
  id: number;
  name: string;
  failCount: number;
  status: number;
  lastTestOk: number | null;
  disabledReason: string | null;
}
interface ChannelRow24h {
  id: number;
  name: string;
  status: number;
  lastTestMs: number | null;
  lastTestOk: number | null;
  calls24h: number;
  avgLatencyMs: number;
}

export function AdminDashboard() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 12 });
  const user = useAuthStore((s) => s.session?.user);
  const resolved = useThemeStore((s) => s.resolved);

  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [ov, setOv] = useState<Overview | null>(null);
  const [series, setSeries] = useState<DailyPoint[]>([]);
  const [topUsers, setTopUsers] = useState<TopUser[]>([]);
  const [topModels, setTopModels] = useState<TopModel[]>([]);
  const [qpsPoints, setQpsPoints] = useState<QpsPoint[]>([]);
  const [chans24h, setChans24h] = useState<ChannelRow24h[]>([]);
  const [sysStat, setSysStat] = useState<SystemStatus | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [perfData, setPerfData] = useState<PerfData | null>(null);
  const [groupSpend, setGroupSpend] = useState<GroupSpend[]>([]);
  const [failing, setFailing] = useState<FailingChannel[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [s, o, ts, tu, tm, qp, c24, sys, act, perf, gs, fc] = await Promise.all([
        adminServerStatus().catch(() => null),
        apiGet<{ overview: Overview }>("/api/admin/dashboard/overview").catch(() => null),
        apiGet<{ points: DailyPoint[] }>("/api/admin/dashboard/timeseries?days=30").catch(
          () => null,
        ),
        apiGet<{ topUsers: TopUser[] }>("/api/admin/dashboard/top-users?n=10").catch(
          () => null,
        ),
        apiGet<{ topModels: TopModel[] }>("/api/admin/dashboard/top-models?n=10").catch(
          () => null,
        ),
        apiGet<{ points: QpsPoint[] }>("/api/admin/dashboard/qps?minutes=60").catch(() => null),
        apiGet<{ channels: ChannelRow24h[] }>("/api/admin/dashboard/channels-24h").catch(
          () => null,
        ),
        apiGet<SystemStatus>("/api/admin/dashboard/system").catch(() => null),
        apiGet<Activity>("/api/admin/dashboard/activity").catch(() => null),
        apiGet<PerfData>("/api/admin/dashboard/perf").catch(() => null),
        apiGet<{ groups: GroupSpend[] }>("/api/admin/dashboard/group-spend").catch(
          () => null,
        ),
        apiGet<{ channels: FailingChannel[] }>("/api/admin/dashboard/failing-channels").catch(
          () => null,
        ),
      ]);
      if (s) setStatus(s);
      if (o) setOv(o.overview);
      if (ts) setSeries(ts.points);
      if (tu) setTopUsers(tu.topUsers);
      if (tm) setTopModels(tm.topModels);
      if (qp) setQpsPoints(qp.points);
      if (c24) setChans24h(c24.channels);
      if (sys) setSysStat(sys);
      if (act) setActivity(act);
      if (perf) setPerfData(perf);
      if (gs) setGroupSpend(gs.groups);
      if (fc) setFailing(fc.channels);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(refresh, 30_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  return (
    <div ref={ref} className="h-full overflow-y-auto px-8 py-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">{t("admin.dash.title")}</h1>
            <p className="mt-1 text-sm text-muted">{t("admin.dash.subtitle")}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
            {t("common.refresh")}
          </Button>
        </header>

        {/* KPI 卡 */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Kpi
            icon={ServerCog}
            label={t("admin.dash.serverState")}
            value={status?.running ? t("admin.dash.running") : t("admin.dash.stopped")}
            hint={status?.boundAddress ?? undefined}
            accent={status?.running ? "text-success" : "text-danger"}
          />
          <Kpi
            icon={Users}
            label={t("admin.dash.users")}
            value={String(ov?.usersTotal ?? "—")}
            hint={t("admin.dash.newToday", { n: String(ov?.usersNewToday ?? 0) })}
            accent="text-primary"
          />
          <Kpi
            icon={Activity}
            label={t("admin.dash.callsToday")}
            value={(ov?.callsToday ?? 0).toLocaleString()}
            hint={t("admin.dash.tokensToday", {
              n: (ov?.tokensToday ?? 0).toLocaleString(),
            })}
            accent="text-info"
          />
          <Kpi
            icon={Coins}
            label={t("admin.dash.costToday")}
            value={`$${Number(ov?.costTodayUsd ?? "0").toFixed(4)}`}
            hint={t("admin.dash.cost30d", {
              v: `$${Number(ov?.cost30dUsd ?? "0").toFixed(2)}`,
            })}
            accent="text-warning"
          />
        </div>

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
          <Kpi
            icon={Network}
            label={t("admin.dash.channels")}
            value={`${ov?.channelsEnabled ?? 0} / ${ov?.channelsTotal ?? 0}`}
            hint={
              ov && ov.channelsFailing > 0
                ? t("admin.dash.channelsFailing", { n: String(ov.channelsFailing) })
                : t("admin.dash.channelsAllOk")
            }
            accent={
              ov && ov.channelsFailing > 0 ? "text-warning" : "text-success"
            }
          />
          <Kpi
            icon={Database}
            label={t("admin.dash.dbState")}
            value={status?.initialized ? t("admin.dash.dbReady") : t("admin.dash.dbNotReady")}
            accent={status?.initialized ? "text-success" : "text-warning"}
          />
          <Kpi
            icon={Users}
            label={t("admin.dash.invitations")}
            value={String(ov?.invitationsTotal ?? 0)}
            hint={user?.role}
            accent="text-info"
          />
        </div>

        {/* 30 天调用 / Token 折线 */}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <ChartCard title={t("admin.dash.chartCalls")}>
            <Chart option={callsLineOption(series, t("admin.dash.legend.calls"))} />
          </ChartCard>
          <ChartCard title={t("admin.dash.chartTokens")}>
            <Chart
              option={tokensStackOption(
                series,
                t("admin.dash.legend.inputTokens"),
                t("admin.dash.legend.outputTokens"),
              )}
            />
          </ChartCard>
        </div>

        {/* DAU / WAU / MAU + 当前在线 */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Kpi
            icon={Users}
            label="DAU"
            value={(activity?.dau ?? 0).toLocaleString()}
            accent="text-info"
          />
          <Kpi
            icon={Users}
            label="WAU"
            value={(activity?.wau ?? 0).toLocaleString()}
            accent="text-primary"
          />
          <Kpi
            icon={Users}
            label="MAU"
            value={(activity?.mau ?? 0).toLocaleString()}
            accent="text-warning"
          />
          <Kpi
            icon={Users}
            label={t("admin.dash.online")}
            value={(activity?.online ?? 0).toLocaleString()}
            accent="text-success"
          />
        </div>

        {/* 性能 p50/p95/p99 */}
        {perfData && (
          <div className="rounded-2xl border border-border bg-surface/60 p-4 backdrop-blur-xl">
            <p className="mb-3 text-xs font-semibold text-muted">{t("admin.dash.perf")}</p>
            <div className="grid grid-cols-3 gap-3">
              <PerfBox label="p50" ms={perfData.globalP50} />
              <PerfBox label="p95" ms={perfData.globalP95} />
              <PerfBox label="p99" ms={perfData.globalP99} />
            </div>
          </div>
        )}

        {/* QPS（近 60 分钟） + 渠道 24h */}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <ChartCard title={t("admin.dash.chartQps")}>
            {qpsPoints.length > 0 ? (
              <Chart option={qpsLineOption(qpsPoints, t("admin.dash.legend.calls"))} />
            ) : (
              <div className="grid h-full place-items-center text-xs text-muted">
                {t("admin.dash.emptyChart")}
              </div>
            )}
          </ChartCard>
          <ChartCard title={t("admin.dash.chartChans24h")}>
            {chans24h.length > 0 ? (
              <Chart
                option={channelStackOption(
                  chans24h,
                  t("admin.dash.legend.calls"),
                  t("admin.dash.legend.latency"),
                )}
              />
            ) : (
              <div className="grid h-full place-items-center text-xs text-muted">
                {t("admin.dash.emptyChart")}
              </div>
            )}
          </ChartCard>
        </div>

        {/* 用户分组消费占比 + TOP 10 异常渠道 */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ChartCard title={t("admin.dash.groupSpend")}>
            {groupSpend.length > 0 ? (
              <Chart option={groupSpendPieOption(groupSpend, t("admin.dash.totalSpend"), resolved)} />
            ) : (
              <div className="grid h-full place-items-center text-xs text-muted">
                {t("admin.dash.emptyChart")}
              </div>
            )}
          </ChartCard>
          <ChartCard title={t("admin.dash.failingChannels")}>
            <TopTable
              cols={[
                t("admin.dash.col.channel"),
                t("admin.dash.col.failCount"),
                t("admin.dash.col.status"),
              ]}
              rows={failing.map((c) => [
                c.name,
                c.failCount,
                c.status === 0 ? "🔴" : c.lastTestOk === 0 ? "🟡" : "🟢",
              ])}
              emptyText={t("admin.dash.emptyChart")}
              small
            />
          </ChartCard>
        </div>

        {/* 系统状态 */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
          <SystemBar
            icon={Cpu}
            label={t("admin.dash.cpu")}
            pct={sysStat?.cpuPct ?? 0}
            display={`${(sysStat?.cpuPct ?? 0).toFixed(1)}%`}
          />
          <SystemBar
            icon={HardDrive}
            label={t("admin.dash.mem")}
            pct={sysStat?.memUsedPct ?? 0}
            display={`${(sysStat?.memUsedPct ?? 0).toFixed(1)}% (${formatBytes(
              sysStat?.memUsedBytes ?? 0,
            )} / ${formatBytes(sysStat?.memTotalBytes ?? 0)})`}
          />
          <SystemBar
            icon={Zap}
            label={t("admin.dash.redisClients")}
            pct={Math.min((sysStat?.redisClients ?? 0) * 10, 100)}
            display={String(sysStat?.redisClients ?? 0)}
          />
        </div>

        {/* TOP 列表 */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ChartCard title={t("admin.dash.topUsers")}>
            <TopTable
              cols={[
                t("admin.dash.col.user"),
                t("admin.dash.col.calls"),
                t("admin.dash.col.tokens"),
                t("admin.dash.col.cost"),
              ]}
              rows={topUsers.map((u) => [
                u.username,
                u.calls.toLocaleString(),
                u.tokens.toLocaleString(),
                `$${Number(u.costUsd).toFixed(4)}`,
              ])}
              emptyText={t("admin.dash.emptyTop")}
            />
          </ChartCard>
          <ChartCard title={t("admin.dash.topModels")}>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="h-56">
                {topModels.length > 0 ? (
                  <Chart option={modelsPieOption(topModels, t("admin.dash.totalTokens"), resolved)} />
                ) : (
                  <div className="grid h-full place-items-center text-xs text-muted">
                    {t("admin.dash.emptyTop")}
                  </div>
                )}
              </div>
              <TopTable
                cols={[t("admin.dash.col.model"), t("admin.dash.col.tokens")]}
                rows={topModels.map((m) => [m.model, m.tokens.toLocaleString()])}
                emptyText={t("admin.dash.emptyTop")}
                small
              />
            </div>
          </ChartCard>
        </div>

        {/* 旧的"打开客户端窗口"按钮保留 */}
        <div className="rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
          <h2 className="text-sm font-semibold">{t("admin.dash.welcomeTitle")}</h2>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            {t("admin.dash.welcomeBody")}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={async () => {
                try {
                  await openClientWindow();
                } catch (e: any) {
                  notify("error", t("admin.dash.openClientFail"), e?.message);
                }
              }}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t("admin.dash.openClient")}
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-muted/70">
            {t("admin.dash.openClientHint")}
          </p>
        </div>
      </div>
    </div>
  );
}

function Kpi({
  icon: Icon,
  label,
  value,
  hint,
  accent,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint?: string;
  accent: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface/60 p-4 shadow-soft backdrop-blur-xl">
      <div className="flex items-center gap-2 text-xs text-muted">
        <Icon className={`h-4 w-4 ${accent}`} />
        {label}
      </div>
      <div className="mt-2 text-lg font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-1 truncate text-[11px] text-muted/70">{hint}</div>}
    </div>
  );
}

function ChartCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface/60 p-4 backdrop-blur-xl">
      <p className="mb-3 text-xs font-semibold text-muted">{title}</p>
      <div className="h-64">{children}</div>
    </div>
  );
}

function TopTable({
  cols,
  rows,
  emptyText,
  small,
}: {
  cols: string[];
  rows: (string | number)[][];
  emptyText: string;
  small?: boolean;
}) {
  if (rows.length === 0)
    return (
      <div className="grid h-full place-items-center text-xs text-muted">
        {emptyText}
      </div>
    );
  return (
    <div className="h-full overflow-auto">
      <table className={"w-full " + (small ? "text-[11px]" : "text-xs")}>
        <thead className="text-muted">
          <tr>
            {cols.map((c) => (
              <th key={c} className="px-2 py-1.5 text-left font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-border/40">
              {r.map((cell, j) => (
                <td
                  key={j}
                  className={"px-2 py-1.5 " + (j > 0 ? "tabular-nums" : "font-medium")}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ----------------------------------------------------------------------------
// ECharts option builders
// ----------------------------------------------------------------------------

function callsLineOption(
  points: DailyPoint[],
  callsLabel: string,
): EChartsOption {
  return {
    tooltip: { trigger: "axis" },
    legend: { data: [callsLabel], top: 0 },
    xAxis: { type: "category", data: points.map((p) => p.day) },
    yAxis: { type: "value" },
    series: [
      {
        name: callsLabel,
        type: "line",
        smooth: true,
        showSymbol: false,
        areaStyle: { opacity: 0.18 },
        data: points.map((p) => p.calls),
      },
    ],
  };
}

function tokensStackOption(
  points: DailyPoint[],
  inputLabel: string,
  outputLabel: string,
): EChartsOption {
  return {
    tooltip: { trigger: "axis", axisPointer: { type: "cross" } },
    legend: { data: [inputLabel, outputLabel], top: 0 },
    xAxis: { type: "category", data: points.map((p) => p.day) },
    yAxis: { type: "value" },
    series: [
      {
        name: inputLabel,
        type: "bar",
        stack: "tok",
        data: points.map((p) => p.inputTokens),
      },
      {
        name: outputLabel,
        type: "bar",
        stack: "tok",
        data: points.map((p) => p.outputTokens),
      },
    ],
  };
}

function qpsLineOption(points: QpsPoint[], label: string): EChartsOption {
  return {
    tooltip: { trigger: "axis" },
    legend: { data: [label], top: 0 },
    xAxis: {
      type: "category",
      data: points.map((p) => p.bucket.slice(-5)),
      axisLabel: { fontSize: 9 },
    },
    yAxis: { type: "value" },
    series: [
      {
        name: label,
        type: "line",
        smooth: true,
        showSymbol: false,
        areaStyle: { opacity: 0.2 },
        data: points.map((p) => p.calls),
      },
    ],
  };
}

function channelStackOption(
  rows: ChannelRow24h[],
  callsLabel: string,
  latLabel: string,
): EChartsOption {
  const names = rows.map((c) => c.name);
  return {
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    legend: { data: [callsLabel, latLabel], top: 0 },
    grid: { left: 80, right: 50, top: 24, bottom: 10 },
    xAxis: [
      { type: "value", name: callsLabel, position: "top" },
      { type: "value", name: latLabel, position: "bottom" },
    ],
    yAxis: { type: "category", data: names, axisLabel: { fontSize: 10 } },
    series: [
      {
        name: callsLabel,
        type: "bar",
        xAxisIndex: 0,
        data: rows.map((c) => ({
          value: c.calls24h,
          itemStyle: {
            color:
              c.status === 0
                ? "#dc2626"
                : c.lastTestOk === 0
                ? "#f59e0b"
                : "#22c55e",
          },
        })),
      },
      {
        name: latLabel,
        type: "bar",
        xAxisIndex: 1,
        data: rows.map((c) => c.avgLatencyMs),
        itemStyle: { color: "#6366f1" },
      },
    ],
  };
}

function groupSpendPieOption(
  rows: GroupSpend[],
  totalLabel: string,
  resolved: "dark" | "light",
): EChartsOption {
  const total = rows.reduce((s, g) => s + Number(g.costUsd || 0), 0);
  const labelColor = resolved === "dark" ? "rgba(228,231,236,0.65)" : "rgba(40,46,56,0.6)";
  const valueColor = resolved === "dark" ? "rgba(228,231,236,0.95)" : "rgba(40,46,56,0.92)";
  const borderColor = resolved === "dark" ? "#15171c" : "#fff";
  return {
    tooltip: { trigger: "item", formatter: "{b}: ${c} ({d}%)" },
    legend: { show: false },
    title: {
      text: totalLabel,
      subtext: `$${total.toFixed(2)}`,
      left: "50%",
      top: "50%",
      textAlign: "center",
      textVerticalAlign: "middle",
      textStyle: { fontSize: 11, color: labelColor, fontWeight: "normal" },
      subtextStyle: { fontSize: 16, fontWeight: 600, color: valueColor },
      itemGap: 4,
    },
    series: [
      {
        type: "pie",
        radius: ["45%", "70%"],
        center: ["50%", "50%"],
        avoidLabelOverlap: true,
        itemStyle: { borderRadius: 4, borderColor, borderWidth: 1 },
        label: { fontSize: 11 },
        data: rows.map((g) => ({
          name: g.name,
          value: Number(g.costUsd),
        })),
      },
    ],
  };
}

function PerfBox({ label, ms }: { label: string; ms: number }) {
  return (
    <div className="rounded-xl border border-border bg-surface-2/40 p-3 text-center">
      <p className="text-[10px] uppercase tracking-wider text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{ms} <span className="text-xs text-muted">ms</span></p>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)}KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)}MB`;
  return `${(mb / 1024).toFixed(2)}GB`;
}

function SystemBar({
  icon: Icon,
  label,
  pct,
  display,
}: {
  icon: LucideIcon;
  label: string;
  pct: number;
  display: string;
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  const color =
    clamped > 85 ? "bg-danger" : clamped > 65 ? "bg-warning" : "bg-success";
  return (
    <div className="rounded-2xl border border-border bg-surface/60 p-4 shadow-soft backdrop-blur-xl">
      <div className="flex items-center gap-2 text-xs text-muted">
        <Icon className="h-4 w-4 text-primary" />
        {label}
      </div>
      <div className="mt-2 text-lg font-semibold tabular-nums">{display}</div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div
          className={`h-full transition-all ${color}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}

function modelsPieOption(
  top: TopModel[],
  totalLabel: string,
  resolved: "dark" | "light",
): EChartsOption {
  const totalTokens = top.reduce((s, m) => s + (m.tokens || 0), 0);
  const labelColor = resolved === "dark" ? "rgba(228,231,236,0.65)" : "rgba(40,46,56,0.6)";
  const valueColor = resolved === "dark" ? "rgba(228,231,236,0.95)" : "rgba(40,46,56,0.92)";
  const borderColor = resolved === "dark" ? "#15171c" : "#fff";
  return {
    tooltip: { trigger: "item" },
    legend: { show: false },
    title: {
      text: totalLabel,
      subtext: totalTokens.toLocaleString(),
      left: "50%",
      top: "50%",
      textAlign: "center",
      textVerticalAlign: "middle",
      textStyle: { fontSize: 11, color: labelColor, fontWeight: "normal" },
      subtextStyle: { fontSize: 14, fontWeight: 600, color: valueColor },
      itemGap: 4,
    },
    series: [
      {
        type: "pie",
        radius: ["50%", "72%"],
        center: ["50%", "50%"],
        avoidLabelOverlap: true,
        itemStyle: { borderRadius: 4, borderColor, borderWidth: 1 },
        label: { fontSize: 11 },
        data: top.map((m) => ({
          name: m.model.split("-").slice(-2).join("-"),
          value: m.tokens,
        })),
      },
    ],
  };
}

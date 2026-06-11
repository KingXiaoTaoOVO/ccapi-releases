import { useCallback, useEffect, useState } from "react";
import { Activity, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { apiGet } from "@/services/apiClient";
import { notify } from "@/services/notify";

interface UsageLog {
  id: number;
  userId: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: string;
  pool: "bonus" | "base";
  requestId: string | null;
  createdAt: string | null;
}

interface UsageSummaryRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: string;
}

export function UsageMonitor() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 12 });
  const [userId, setUserId] = useState("");
  const [logs, setLogs] = useState<UsageLog[]>([]);
  const [summary, setSummary] = useState<UsageSummaryRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = userId ? `?userId=${userId}` : "";
      const [a, b] = await Promise.all([
        apiGet<{ logs: UsageLog[] }>(`/api/admin/usage${q}`),
        apiGet<{ byModel: UsageSummaryRow[] }>(`/api/admin/usage/summary${q}`),
      ]);
      setLogs(a.logs);
      setSummary(b.byModel);
    } catch (e: any) {
      notify("error", "加载失败", e?.message);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalCost = summary.reduce(
    (s, x) => s + (Number(x.costUsd) || 0),
    0,
  );
  const totalTokens = summary.reduce(
    (s, x) => s + x.inputTokens + x.outputTokens,
    0,
  );

  return (
    <div ref={ref} className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border/60 px-6 py-4">
        <Activity className="h-4 w-4 text-primary" />
        <h1 className="text-sm font-semibold">{t("admin.usage.title")}</h1>
        <TextField
          placeholder={t("admin.usage.userPlaceholder")}
          value={userId}
          onChange={(e) => setUserId(e.target.value.replace(/[^0-9]/g, ""))}
          className="max-w-[180px]"
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void load()}
          loading={loading}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {t("admin.usage.reload")}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 space-y-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Stat label={t("admin.usage.totalCost")} value={`$${totalCost.toFixed(4)}`} />
          <Stat label={t("admin.usage.totalTokens")} value={totalTokens.toLocaleString()} />
          <Stat label={t("admin.usage.models")} value={String(summary.length)} />
        </div>

        <section className="rounded-2xl border border-border bg-surface/40">
          <header className="border-b border-border px-4 py-2.5 text-xs font-semibold text-muted">
            {t("admin.usage.byModel")}
          </header>
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-xs text-muted">
              <tr>
                <th className="px-3 py-2 text-left">Model</th>
                <th className="px-3 py-2 text-right">Input</th>
                <th className="px-3 py-2 text-right">Output</th>
                <th className="px-3 py-2 text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((s) => (
                <tr key={s.model} className="border-t border-border/40">
                  <td className="px-3 py-2 font-medium">{s.model}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {s.inputTokens.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {s.outputTokens.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    ${Number(s.costUsd).toFixed(4)}
                  </td>
                </tr>
              ))}
              {summary.length === 0 && (
                <tr>
                  <td colSpan={4} className="p-6 text-center text-xs text-muted">
                    {t("admin.usage.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        <section className="rounded-2xl border border-border bg-surface/40">
          <header className="border-b border-border px-4 py-2.5 text-xs font-semibold text-muted">
            {t("admin.usage.recent")}
          </header>
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-xs text-muted">
              <tr>
                <th className="px-3 py-2 text-left">Time</th>
                <th className="px-3 py-2 text-left">User</th>
                <th className="px-3 py-2 text-left">Model</th>
                <th className="px-3 py-2 text-left">Pool</th>
                <th className="px-3 py-2 text-right">Tokens</th>
                <th className="px-3 py-2 text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id} className="border-t border-border/40">
                  <td className="px-3 py-2 text-xs text-muted">
                    {l.createdAt
                      ? new Date(l.createdAt + "Z").toLocaleString()
                      : "—"}
                  </td>
                  <td className="px-3 py-2 text-xs">{l.userId}</td>
                  <td className="px-3 py-2 text-xs">{l.model}</td>
                  <td className="px-3 py-2 text-xs">
                    <span
                      className={
                        l.pool === "bonus"
                          ? "rounded-full bg-info/15 px-1.5 py-0.5 text-info"
                          : "rounded-full bg-surface-2 px-1.5 py-0.5 text-muted"
                      }
                    >
                      {l.pool}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {(l.inputTokens + l.outputTokens).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    ${Number(l.costUsd).toFixed(4)}
                  </td>
                </tr>
              ))}
              {logs.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-6 text-center text-xs text-muted">
                    {t("admin.usage.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-surface/60 p-4 backdrop-blur-xl">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

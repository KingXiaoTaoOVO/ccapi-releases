import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { apiGet } from "@/services/apiClient";

interface LogRow {
  id: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: string;
  pool: "bonus" | "base";
  requestId: string | null;
  createdAt: string | null;
}

export function QuotaLog() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 12 });
  const [rows, setRows] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await apiGet<{ logs: LogRow[] }>("/api/user/me/usage");
      setRows(d.logs);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const totalCost = rows.reduce((s, r) => s + Number(r.costUsd || 0), 0);
  const totalTokens = rows.reduce(
    (s, r) => s + r.inputTokens + r.outputTokens,
    0,
  );

  return (
    <div ref={ref} className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-border/60 px-6 py-4">
        <h1 className="text-sm font-semibold">{t("client.quota.title")}</h1>
        <span className="text-xs text-muted">
          {t("client.quota.totalCost", { v: totalCost.toFixed(4) })} ·{" "}
          {t("client.quota.totalTokens", { v: totalTokens.toLocaleString() })}
        </span>
        <Button size="sm" variant="secondary" onClick={() => void load()} loading={loading} className="ml-auto">
          <RefreshCw className="h-3.5 w-3.5" />
          {t("client.quota.reload")}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <div className="overflow-hidden rounded-2xl border border-border bg-surface/40">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-xs text-muted">
              <tr>
                <th className="px-3 py-2 text-left">Time</th>
                <th className="px-3 py-2 text-left">Model</th>
                <th className="px-3 py-2 text-left">Pool</th>
                <th className="px-3 py-2 text-right">Tokens</th>
                <th className="px-3 py-2 text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border/40">
                  <td className="px-3 py-2 text-xs text-muted">
                    {r.createdAt
                      ? new Date(r.createdAt + "Z").toLocaleString()
                      : "—"}
                  </td>
                  <td className="px-3 py-2 text-xs">{r.model}</td>
                  <td className="px-3 py-2 text-xs">
                    <span
                      className={
                        r.pool === "bonus"
                          ? "rounded-full bg-info/15 px-1.5 py-0.5 text-info"
                          : "rounded-full bg-surface-2 px-1.5 py-0.5 text-muted"
                      }
                    >
                      {r.pool}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {(r.inputTokens + r.outputTokens).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    ${Number(r.costUsd).toFixed(4)}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && !loading && (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-xs text-muted">
                    {t("client.quota.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

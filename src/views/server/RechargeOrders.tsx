import { useCallback, useEffect, useState } from "react";
import { Coins, Download, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { apiGet } from "@/services/apiClient";
import { notify } from "@/services/notify";
import { downloadAdminExport } from "@/services/exportDownload";

interface Order {
  id: number;
  orderNo: string;
  userId: number;
  provider: string;
  amountUsd: string;
  currency: string;
  status: string;
  externalId: string | null;
  paidAt: string | null;
  createdAt: string | null;
}

const STATUSES = [
  { value: "", label: "全部状态" },
  { value: "pending", label: "待付" },
  { value: "paid", label: "已付" },
  { value: "failed", label: "失败" },
  { value: "cancelled", label: "已取消" },
  { value: "refunded", label: "已退款" },
];

const STATUS_CLASS: Record<string, string> = {
  pending: "bg-warning/15 text-warning",
  paid: "bg-success/15 text-success",
  failed: "bg-danger/15 text-danger",
  cancelled: "bg-muted/15 text-muted",
  refunded: "bg-info/15 text-info",
};

export function RechargeOrders() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 12 });
  const [list, setList] = useState<Order[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = status ? `?status=${status}` : "";
      const r = await apiGet<{ orders: Order[] }>(
        `/api/admin/recharge/orders${qs}`,
      );
      setList(r.orders);
    } catch (e: any) {
      notify("error", t("common.loadFail"), e?.message);
    } finally {
      setLoading(false);
    }
  }, [status, t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div ref={ref} className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <Coins className="h-5 w-5 text-primary" />
              {t("orders.title")}
            </h1>
            <p className="mt-1 text-sm text-muted">{t("orders.subtitle")}</p>
          </div>
          <div className="flex items-center gap-2">
            <Select
              value={status}
              onValueChange={setStatus}
              options={STATUSES.map((s) => ({ value: s.value, label: s.label }))}
            />
            <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
              {t("common.refresh")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void downloadAdminExport("/api/admin/export/orders.csv", "orders.csv")}
            >
              <Download className="h-3.5 w-3.5" />
              {t("common.exportCsv")}
            </Button>
          </div>
        </header>

        {list.length === 0 ? (
          <div className="grid place-items-center rounded-2xl border border-dashed border-border bg-surface/40 py-16 text-sm text-muted">
            {t("orders.empty")}
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-border bg-surface/60 backdrop-blur-xl">
            <table className="w-full text-sm">
              <thead className="bg-surface-2/60 text-xs text-muted">
                <tr>
                  <th className="px-3 py-2.5 text-left">{t("orders.col.no")}</th>
                  <th className="px-3 py-2.5 text-left">{t("orders.col.user")}</th>
                  <th className="px-3 py-2.5 text-left">{t("orders.col.provider")}</th>
                  <th className="px-3 py-2.5 text-right">{t("orders.col.amount")}</th>
                  <th className="px-3 py-2.5 text-left">{t("orders.col.status")}</th>
                  <th className="px-3 py-2.5 text-left">{t("orders.col.createdAt")}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((o) => (
                  <tr key={o.id} className="border-t border-border/60 hover:bg-surface-2/30">
                    <td className="px-3 py-2.5 font-mono text-xs">{o.orderNo}</td>
                    <td className="px-3 py-2.5">#{o.userId}</td>
                    <td className="px-3 py-2.5">{o.provider}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      ${Number(o.amountUsd).toFixed(2)} {o.currency}
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={
                          "rounded-full px-2 py-0.5 text-[10px] " +
                          (STATUS_CLASS[o.status] ?? "bg-muted/15 text-muted")
                        }
                      >
                        {o.status}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted">
                      {o.createdAt ? new Date(o.createdAt).toLocaleString() : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

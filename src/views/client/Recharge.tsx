import { useCallback, useEffect, useState } from "react";
import { Coins, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { apiGet, apiPost } from "@/services/apiClient";
import { notify } from "@/services/notify";

interface Order {
  id: number;
  orderNo: string;
  provider: string;
  amountUsd: string;
  status: string;
  paidAt: string | null;
  createdAt: string | null;
}

const STATUS_CLASS: Record<string, string> = {
  pending: "bg-warning/15 text-warning",
  paid: "bg-success/15 text-success",
  failed: "bg-danger/15 text-danger",
  cancelled: "bg-muted/15 text-muted",
};

export function Recharge() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 12 });
  const [provider, setProvider] = useState<"epay" | "stripe">("epay");
  const [amount, setAmount] = useState("10");
  const [orders, setOrders] = useState<Order[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await apiGet<{ orders: Order[] }>("/api/me/recharge/orders");
      setOrders(r.orders);
    } catch (e: any) {
      notify("error", t("common.loadFail"), e?.message);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      notify("error", t("recharge.err.amount"));
      return;
    }
    setBusy(true);
    try {
      const r = await apiPost<{
        provider: string;
        orderNo: string;
        redirectUrl?: string;
        clientSecret?: string;
        publishableKey?: string;
      }>("/api/me/recharge/create", { provider, amountUsd: n });
      if (r.redirectUrl) {
        window.open(r.redirectUrl, "_blank");
        notify("success", t("recharge.epay.opened"));
      } else if (r.clientSecret) {
        notify(
          "success",
          t("recharge.stripe.created"),
          `Order ${r.orderNo} → 复制 client_secret 到你的前端 Stripe Element：${r.clientSecret.slice(0, 20)}…`,
        );
      }
      await load();
    } catch (e: any) {
      notify("error", t("recharge.create.fail"), e?.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={ref} className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-2xl space-y-6">
        <header>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Coins className="h-5 w-5 text-primary" />
            {t("recharge.title")}
          </h1>
          <p className="mt-1 text-sm text-muted">{t("recharge.subtitle")}</p>
        </header>

        <section className="space-y-3 rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
          <div className="flex gap-2">
            {(["epay", "stripe"] as const).map((p) => (
              <button
                key={p}
                onClick={() => setProvider(p)}
                className={
                  "flex-1 rounded-xl border px-3 py-3 text-sm transition-colors " +
                  (provider === p
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-surface-2/40 text-muted hover:text-text")
                }
              >
                {t(`recharge.provider.${p}` as never)}
              </button>
            ))}
          </div>
          <TextField
            label={t("recharge.amount")}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            type="number"
            hint={t("recharge.amount.hint")}
          />
          <div className="flex gap-2">
            {["5", "10", "20", "50", "100"].map((v) => (
              <button
                key={v}
                onClick={() => setAmount(v)}
                className="rounded-full border border-border px-3 py-1 text-xs hover:border-primary/40"
              >
                ${v}
              </button>
            ))}
          </div>
          <Button onClick={() => void create()} loading={busy} className="w-full">
            {t("recharge.pay")} ${amount}
          </Button>
        </section>

        <section className="space-y-3 rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">{t("recharge.history")}</h2>
            <Button size="sm" variant="ghost" onClick={() => void load()}>
              <RefreshCw className="h-3.5 w-3.5" />
              {t("common.refresh")}
            </Button>
          </div>
          {orders.length === 0 ? (
            <p className="text-xs text-muted">{t("recharge.empty")}</p>
          ) : (
            orders.map((o) => (
              <div
                key={o.id}
                className="flex items-center gap-3 rounded-xl border border-border bg-surface-2/40 px-3 py-2 text-xs"
              >
                <span className="font-mono">{o.orderNo}</span>
                <span className="text-muted">{o.provider}</span>
                <span className="tabular-nums">${Number(o.amountUsd).toFixed(2)}</span>
                <span
                  className={
                    "ml-auto rounded-full px-2 py-0.5 text-[10px] " +
                    (STATUS_CLASS[o.status] ?? "bg-muted/15 text-muted")
                  }
                >
                  {o.status}
                </span>
                <span className="text-[10px] text-muted">
                  {o.createdAt ? new Date(o.createdAt).toLocaleString() : ""}
                </span>
              </div>
            ))
          )}
        </section>
      </div>
    </div>
  );
}

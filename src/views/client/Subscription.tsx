import { useCallback, useEffect, useState } from "react";
import { Crown, RotateCcw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { apiGet, apiPost } from "@/services/apiClient";
import { notify } from "@/services/notify";
import { confirm } from "@/store/useConfirmStore";

interface Tier {
  id: number;
  code: string;
  displayName: string;
  priceUsd: string;
  quota5hUsd: string;
  quota7dUsd: string;
  multiplier: string;
  enabled: number;
}

interface AutoRenew {
  enabled: boolean;
  tierId: number | null;
}

interface CurrentSub {
  tier: string | null;
  tierExpiresAt: string | null;
}

export function Subscription() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 12 });
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [current, setCurrent] = useState<CurrentSub>({
    tier: null,
    tierExpiresAt: null,
  });
  const [autoRenew, setAutoRenew] = useState<AutoRenew>({
    enabled: false,
    tierId: null,
  });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [tr, q, ar] = await Promise.all([
        apiGet<{ tiers: Tier[] }>("/api/tiers"),
        apiGet<CurrentSub>("/api/user/me/quota"),
        apiGet<AutoRenew>("/api/me/subscription/auto-renew"),
      ]);
      setTiers(tr.tiers.filter((x) => x.enabled));
      setCurrent({ tier: q.tier, tierExpiresAt: q.tierExpiresAt });
      setAutoRenew(ar);
    } catch (e: any) {
      notify("error", t("common.loadFail"), e?.message);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const buy = async (tier: Tier) => {
    const ok = await confirm({
      title: t("sub.buy.title", {
        name: tier.displayName,
        price: Number(tier.priceUsd).toFixed(2),
      }),
      description: t("sub.buy.desc"),
      level: "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await apiPost<{ expiresAt: string }>(
        "/api/me/subscription/renew",
        { tierId: tier.id },
      );
      notify("success", t("sub.renewed", { date: r.expiresAt.slice(0, 10) }));
      await load();
    } catch (e: any) {
      notify("error", t("sub.fail"), e?.message);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    const ok = await confirm({
      title: t("sub.cancel.title"),
      description: t("sub.cancel.desc"),
      level: "critical",
      confirmText: "CANCEL",
    });
    if (!ok) return;
    try {
      await apiPost("/api/me/subscription/cancel", {});
      notify("success", t("sub.cancelled"));
      await load();
    } catch (e: any) {
      notify("error", t("sub.fail"), e?.message);
    }
  };

  const toggleAutoRenew = async (enabled: boolean) => {
    if (enabled && !autoRenew.tierId && tiers.length === 0) {
      notify("error", t("sub.autoRenew.noTier"));
      return;
    }
    const tierId = autoRenew.tierId ?? tiers[0]?.id;
    try {
      await apiPost("/api/me/subscription/auto-renew", {
        enabled,
        tierId,
      });
      setAutoRenew({ enabled, tierId: tierId ?? null });
    } catch (e: any) {
      notify("error", t("common.saveFail"), e?.message);
    }
  };

  return (
    <div ref={ref} className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <header>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Crown className="h-5 w-5 text-primary" />
            {t("sub.title")}
          </h1>
          <p className="mt-1 text-sm text-muted">{t("sub.subtitle")}</p>
        </header>

        {/* 当前订阅 */}
        <section className="rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
          {current.tier ? (
            <div className="space-y-2">
              <p className="text-sm">
                {t("sub.current")}：
                <span className="font-semibold text-primary">{current.tier}</span>
              </p>
              <p className="text-xs text-muted">
                {t("sub.expiresAt")}：
                {current.tierExpiresAt
                  ? new Date(current.tierExpiresAt).toLocaleString()
                  : "-"}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void cancel()}
                  className="text-danger hover:bg-danger/10"
                >
                  <XCircle className="h-3.5 w-3.5" />
                  {t("sub.cancel")}
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted">{t("sub.none")}</p>
          )}
          <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
            <div>
              <p className="text-sm font-medium">{t("sub.autoRenew")}</p>
              <p className="text-xs text-muted">{t("sub.autoRenew.desc")}</p>
            </div>
            <Switch
              checked={autoRenew.enabled}
              onChange={(v) => void toggleAutoRenew(v)}
            />
          </div>
        </section>

        {/* 选档位 */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">{t("sub.pickTier")}</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {tiers.map((t2) => (
              <div
                key={t2.id}
                className="rounded-2xl border border-border bg-surface/60 p-4 backdrop-blur-xl"
              >
                <p className="text-base font-semibold">{t2.displayName}</p>
                <p className="mt-1 text-2xl font-bold tabular-nums">
                  ${Number(t2.priceUsd).toFixed(2)}
                  <span className="ml-1 text-xs text-muted">/{t("sub.month")}</span>
                </p>
                <ul className="mt-3 space-y-1 text-xs text-muted">
                  <li>5h 配额：${Number(t2.quota5hUsd).toFixed(2)}</li>
                  <li>7d 配额：${Number(t2.quota7dUsd).toFixed(2)}</li>
                  <li>倍率：×{Number(t2.multiplier).toFixed(2)}</li>
                </ul>
                <Button
                  className="mt-3 w-full"
                  size="sm"
                  onClick={() => void buy(t2)}
                  loading={busy}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t("sub.buy")}
                </Button>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

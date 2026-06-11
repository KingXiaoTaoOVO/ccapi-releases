import { useCallback, useEffect, useState } from "react";
import { CreditCard, Save } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { TextField } from "@/components/ui/TextField";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { apiGet, apiPatch } from "@/services/apiClient";
import { notify } from "@/services/notify";

interface PaymentCfg {
  epay: {
    enabled: boolean;
    merchantId: string;
    key: string;
    gateway: string;
    notifyUrl: string;
    returnUrl: string;
  };
  stripe: {
    enabled: boolean;
    publishableKey: string;
    secretKey: string;
    webhookSecret: string;
  };
}

const EMPTY: PaymentCfg = {
  epay: {
    enabled: false,
    merchantId: "",
    key: "",
    gateway: "",
    notifyUrl: "",
    returnUrl: "",
  },
  stripe: {
    enabled: false,
    publishableKey: "",
    secretKey: "",
    webhookSecret: "",
  },
};

export function PaymentConfig() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 12 });
  const [cfg, setCfg] = useState<PaymentCfg>(EMPTY);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await apiGet<{ config: Record<string, PaymentCfg> }>(
        "/api/admin/config",
      );
      if (r.config?.payment_config) {
        setCfg({ ...EMPTY, ...r.config.payment_config });
      }
    } catch (e: any) {
      notify("error", t("common.loadFail"), e?.message);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      await apiPatch("/api/admin/config", { payment_config: cfg });
      notify("success", t("common.saved"));
    } catch (e: any) {
      notify("error", t("common.saveFail"), e?.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div ref={ref} className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="flex items-end justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <CreditCard className="h-5 w-5 text-primary" />
              {t("payment.title")}
            </h1>
            <p className="mt-1 text-sm text-muted">{t("payment.subtitle")}</p>
          </div>
          <Button onClick={() => void save()} loading={saving}>
            <Save className="h-3.5 w-3.5" />
            {t("common.save")}
          </Button>
        </header>

        {/* EPay */}
        <section className="space-y-3 rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">{t("payment.epay")}</h2>
            <Switch
              checked={cfg.epay.enabled}
              onChange={(v) =>
                setCfg((s) => ({ ...s, epay: { ...s.epay, enabled: v } }))
              }
            />
          </div>
          <TextField
            label={t("payment.epay.merchantId")}
            value={cfg.epay.merchantId}
            onChange={(e) =>
              setCfg((s) => ({
                ...s,
                epay: { ...s.epay, merchantId: e.target.value },
              }))
            }
          />
          <TextField
            label={t("payment.epay.key")}
            type="password"
            value={cfg.epay.key}
            onChange={(e) =>
              setCfg((s) => ({ ...s, epay: { ...s.epay, key: e.target.value } }))
            }
          />
          <TextField
            label={t("payment.epay.gateway")}
            value={cfg.epay.gateway}
            onChange={(e) =>
              setCfg((s) => ({
                ...s,
                epay: { ...s.epay, gateway: e.target.value },
              }))
            }
            placeholder="https://pay.example.com/submit.php"
          />
          <TextField
            label={t("payment.epay.notifyUrl")}
            value={cfg.epay.notifyUrl}
            onChange={(e) =>
              setCfg((s) => ({
                ...s,
                epay: { ...s.epay, notifyUrl: e.target.value },
              }))
            }
            placeholder="https://yourhost/api/recharge/epay/notify"
          />
          <TextField
            label={t("payment.epay.returnUrl")}
            value={cfg.epay.returnUrl}
            onChange={(e) =>
              setCfg((s) => ({
                ...s,
                epay: { ...s.epay, returnUrl: e.target.value },
              }))
            }
            placeholder="https://yourhost/recharge/done"
          />
        </section>

        {/* Stripe */}
        <section className="space-y-3 rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">{t("payment.stripe")}</h2>
            <Switch
              checked={cfg.stripe.enabled}
              onChange={(v) =>
                setCfg((s) => ({ ...s, stripe: { ...s.stripe, enabled: v } }))
              }
            />
          </div>
          <TextField
            label={t("payment.stripe.publishableKey")}
            value={cfg.stripe.publishableKey}
            onChange={(e) =>
              setCfg((s) => ({
                ...s,
                stripe: { ...s.stripe, publishableKey: e.target.value },
              }))
            }
            placeholder="pk_live_..."
          />
          <TextField
            label={t("payment.stripe.secretKey")}
            type="password"
            value={cfg.stripe.secretKey}
            onChange={(e) =>
              setCfg((s) => ({
                ...s,
                stripe: { ...s.stripe, secretKey: e.target.value },
              }))
            }
            placeholder="sk_live_..."
          />
          <TextField
            label={t("payment.stripe.webhookSecret")}
            type="password"
            value={cfg.stripe.webhookSecret}
            onChange={(e) =>
              setCfg((s) => ({
                ...s,
                stripe: { ...s.stripe, webhookSecret: e.target.value },
              }))
            }
            placeholder="whsec_..."
          />
          <p className="text-xs text-muted">
            Webhook URL: <code className="rounded bg-surface-2 px-1.5 py-0.5">/api/recharge/stripe/webhook</code>
          </p>
        </section>
      </div>
    </div>
  );
}

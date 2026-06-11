import { useCallback, useEffect, useState } from "react";
import { Globe, Save } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { apiGet, apiPatch } from "@/services/apiClient";
import { notify } from "@/services/notify";

interface SiteInfo {
  name: string;
  logoUrl: string;
  icpRecord: string;
  footer: string;
  announcement: string;
  updateRepo: string;
}

interface RegPolicy {
  open: boolean;
  requireInviteCode: boolean;
  requireEmailVerify: boolean;
  captchaStrength: "off" | "easy" | "normal" | "strong";
}

const EMPTY_SITE: SiteInfo = {
  name: "CCAPI",
  logoUrl: "",
  icpRecord: "",
  footer: "",
  announcement: "",
  updateRepo: "KingXiaoTaoOVO/ccapi-releases",
};
const EMPTY_POLICY: RegPolicy = {
  open: true,
  requireInviteCode: false,
  requireEmailVerify: false,
  captchaStrength: "normal",
};

export function SiteConfig() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 12 });
  const [site, setSite] = useState<SiteInfo>(EMPTY_SITE);
  const [policy, setPolicy] = useState<RegPolicy>(EMPTY_POLICY);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([
        apiGet<{ site: SiteInfo }>("/api/admin/site"),
        apiGet<{ policy: RegPolicy }>("/api/admin/register-policy"),
      ]);
      setSite({ ...EMPTY_SITE, ...s.site });
      setPolicy({ ...EMPTY_POLICY, ...p.policy });
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
      await apiPatch("/api/admin/site", site);
      await apiPatch("/api/admin/register-policy", policy);
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
              <Globe className="h-5 w-5 text-primary" />
              {t("site.title")}
            </h1>
            <p className="mt-1 text-sm text-muted">{t("site.subtitle")}</p>
          </div>
          <Button onClick={() => void save()} loading={saving}>
            <Save className="h-3.5 w-3.5" />
            {t("common.save")}
          </Button>
        </header>

        <section className="space-y-3 rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
          <h2 className="text-sm font-semibold">{t("site.info")}</h2>
          <TextField
            label={t("site.name")}
            value={site.name}
            onChange={(e) => setSite((s) => ({ ...s, name: e.target.value }))}
            placeholder="CCAPI"
          />
          <TextField
            label={t("site.logoUrl")}
            value={site.logoUrl}
            onChange={(e) => setSite((s) => ({ ...s, logoUrl: e.target.value }))}
            placeholder="https://example.com/logo.png"
          />
          <TextField
            label={t("site.icp")}
            value={site.icpRecord}
            onChange={(e) => setSite((s) => ({ ...s, icpRecord: e.target.value }))}
            placeholder="京 ICP 备 12345678 号"
          />
          <TextField
            label={t("site.footer")}
            value={site.footer}
            onChange={(e) => setSite((s) => ({ ...s, footer: e.target.value }))}
            placeholder="Powered by CCAPI"
          />
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">
              {t("site.announcement")}
            </label>
            <textarea
              value={site.announcement}
              onChange={(e) =>
                setSite((s) => ({ ...s, announcement: e.target.value }))
              }
              rows={3}
              placeholder={t("site.announcement.ph")}
              className="w-full rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 text-sm outline-none focus:border-primary/60"
            />
          </div>
          <TextField
            label={t("site.updateRepo")}
            value={site.updateRepo}
            onChange={(e) =>
              setSite((s) => ({ ...s, updateRepo: e.target.value }))
            }
            placeholder="KingXiaoTaoOVO/ccapi-releases"
            hint={t("site.updateRepo.hint")}
          />
        </section>

        <section className="space-y-3 rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
          <h2 className="text-sm font-semibold">{t("site.regPolicy")}</h2>
          <Toggle
            label={t("site.policy.open")}
            checked={policy.open}
            onChange={(v) => setPolicy((p) => ({ ...p, open: v }))}
          />
          <Toggle
            label={t("site.policy.invite")}
            checked={policy.requireInviteCode}
            onChange={(v) => setPolicy((p) => ({ ...p, requireInviteCode: v }))}
          />
          <Toggle
            label={t("site.policy.emailVerify")}
            checked={policy.requireEmailVerify}
            onChange={(v) => setPolicy((p) => ({ ...p, requireEmailVerify: v }))}
          />
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">
              {t("site.policy.captchaStrength")}
            </label>
            <div className="flex gap-2">
              {(["off", "easy", "normal", "strong"] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setPolicy((p) => ({ ...p, captchaStrength: v }))}
                  className={
                    "rounded-full border px-3 py-1 text-xs transition-colors " +
                    (policy.captchaStrength === v
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-surface-2/40 text-muted hover:text-text")
                  }
                >
                  {t(`site.policy.captcha.${v}` as never)}
                </button>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2 py-2 hover:bg-surface-2/40">
      <span className="text-sm">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-primary"
      />
    </label>
  );
}

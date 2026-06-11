import { useCallback, useEffect, useState } from "react";
import { Cog, FileText, Gauge, Save } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { JsonEditor } from "@/components/ui/JsonEditor";
import { Switch } from "@/components/ui/Switch";
import { TextField } from "@/components/ui/TextField";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { apiGet, apiPatch } from "@/services/apiClient";
import { notify } from "@/services/notify";

type Tab = "billing" | "advanced" | "docs" | "perf";

interface BillingRules {
  defaultMultiplier: number;
  minBillingUnit: number;
  roundDecimals: number;
}
interface SystemAdv {
  chatEnabled: boolean;
  drawEnabled: boolean;
  dashboardEnabled: boolean;
}
interface DocsContent {
  title: string;
  markdown: string;
}
interface PerfData {
  globalP50: number;
  globalP95: number;
  globalP99: number;
  perChannel: { channelId: number | null; name: string | null; calls: number; avgMs: number; maxMs: number }[];
}

export function SystemAdvanced() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 12 });
  const [tab, setTab] = useState<Tab>("billing");
  const [billing, setBilling] = useState<BillingRules>({
    defaultMultiplier: 1.0,
    minBillingUnit: 0.000001,
    roundDecimals: 6,
  });
  const [adv, setAdv] = useState<SystemAdv>({
    chatEnabled: true,
    drawEnabled: true,
    dashboardEnabled: true,
  });
  const [docs, setDocs] = useState<DocsContent>({ title: "", markdown: "" });
  const [perf, setPerf] = useState<PerfData | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const cfg = await apiGet<{
        config: { billing_rules?: BillingRules; system_advanced?: SystemAdv; docs_content?: DocsContent };
      }>("/api/admin/config");
      if (cfg.config?.billing_rules) {
        setBilling({ ...billing, ...cfg.config.billing_rules });
      }
      if (cfg.config?.system_advanced) {
        setAdv({ ...adv, ...cfg.config.system_advanced });
      }
      if (cfg.config?.docs_content) {
        setDocs({ ...docs, ...cfg.config.docs_content });
      }
      const p = await apiGet<PerfData>("/api/admin/dashboard/perf").catch(() => null);
      if (p) setPerf(p);
    } catch (e: any) {
      notify("error", t("common.loadFail"), e?.message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (key: string, value: unknown) => {
    setSaving(true);
    try {
      await apiPatch("/api/admin/config", { [key]: value });
      notify("success", t("common.saved"));
    } catch (e: any) {
      notify("error", t("common.saveFail"), e?.message);
    } finally {
      setSaving(false);
    }
  };

  const TABS: { key: Tab; label: string; icon: typeof Cog }[] = [
    { key: "billing", label: t("sysadv.billing"), icon: Cog },
    { key: "advanced", label: t("sysadv.advanced"), icon: Cog },
    { key: "docs", label: t("sysadv.docs"), icon: FileText },
    { key: "perf", label: t("sysadv.perf"), icon: Gauge },
  ];

  return (
    <div ref={ref} className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <header>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Cog className="h-5 w-5 text-primary" />
            {t("sysadv.title")}
          </h1>
          <p className="mt-1 text-sm text-muted">{t("sysadv.subtitle")}</p>
        </header>

        <div className="flex gap-1.5 overflow-x-auto rounded-xl border border-border bg-surface/60 p-1">
          {TABS.map((tt) => (
            <button
              key={tt.key}
              onClick={() => setTab(tt.key)}
              className={
                "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-colors " +
                (tab === tt.key
                  ? "bg-primary/15 text-primary"
                  : "text-muted hover:text-text")
              }
            >
              <tt.icon className="h-3.5 w-3.5" />
              {tt.label}
            </button>
          ))}
        </div>

        {tab === "billing" && (
          <section className="space-y-3 rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
            <TextField
              label={t("sysadv.billing.defaultMultiplier")}
              type="number"
              value={String(billing.defaultMultiplier)}
              onChange={(e) =>
                setBilling((s) => ({
                  ...s,
                  defaultMultiplier: Number(e.target.value) || 1,
                }))
              }
              hint={t("sysadv.billing.defaultMultiplier.hint")}
            />
            <TextField
              label={t("sysadv.billing.minUnit")}
              type="number"
              value={String(billing.minBillingUnit)}
              onChange={(e) =>
                setBilling((s) => ({
                  ...s,
                  minBillingUnit: Number(e.target.value) || 0.000001,
                }))
              }
            />
            <TextField
              label={t("sysadv.billing.roundDecimals")}
              type="number"
              value={String(billing.roundDecimals)}
              onChange={(e) =>
                setBilling((s) => ({
                  ...s,
                  roundDecimals: Number(e.target.value) || 6,
                }))
              }
            />
            <Button onClick={() => void save("billing_rules", billing)} loading={saving}>
              <Save className="h-3.5 w-3.5" />
              {t("common.save")}
            </Button>
          </section>
        )}

        {tab === "advanced" && (
          <section className="space-y-3 rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
            <Row
              label={t("sysadv.adv.chatEnabled")}
              checked={adv.chatEnabled}
              onChange={(v) => setAdv((s) => ({ ...s, chatEnabled: v }))}
            />
            <Row
              label={t("sysadv.adv.drawEnabled")}
              checked={adv.drawEnabled}
              onChange={(v) => setAdv((s) => ({ ...s, drawEnabled: v }))}
            />
            <Row
              label={t("sysadv.adv.dashboardEnabled")}
              checked={adv.dashboardEnabled}
              onChange={(v) => setAdv((s) => ({ ...s, dashboardEnabled: v }))}
            />
            <Button onClick={() => void save("system_advanced", adv)} loading={saving}>
              <Save className="h-3.5 w-3.5" />
              {t("common.save")}
            </Button>
          </section>
        )}

        {tab === "docs" && (
          <section className="space-y-3 rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
            <TextField
              label={t("sysadv.docs.title")}
              value={docs.title}
              onChange={(e) => setDocs((s) => ({ ...s, title: e.target.value }))}
            />
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted">
                {t("sysadv.docs.markdown")}
              </label>
              <textarea
                value={docs.markdown}
                onChange={(e) => setDocs((s) => ({ ...s, markdown: e.target.value }))}
                rows={16}
                placeholder="# 使用文档&#10;&#10;支持 markdown 语法..."
                className="w-full rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 font-mono text-xs outline-none focus:border-primary/60"
              />
              <p className="mt-1 text-[11px] text-muted/80">
                {t("sysadv.docs.hint")}
              </p>
            </div>
            <Button onClick={() => void save("docs_content", docs)} loading={saving}>
              <Save className="h-3.5 w-3.5" />
              {t("common.save")}
            </Button>
          </section>
        )}

        {tab === "perf" && (
          <section className="space-y-3 rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
            {perf ? (
              <>
                <div className="grid grid-cols-3 gap-3">
                  <Stat label="p50" value={`${perf.globalP50} ms`} />
                  <Stat label="p95" value={`${perf.globalP95} ms`} />
                  <Stat label="p99" value={`${perf.globalP99} ms`} />
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-semibold">{t("sysadv.perf.perChannel")}</p>
                  {perf.perChannel.length === 0 ? (
                    <p className="text-xs text-muted">{t("sysadv.perf.empty")}</p>
                  ) : (
                    <table className="w-full text-xs">
                      <thead className="text-muted">
                        <tr>
                          <th className="px-2 py-1.5 text-left font-medium">渠道</th>
                          <th className="px-2 py-1.5 text-right font-medium">调用</th>
                          <th className="px-2 py-1.5 text-right font-medium">avg ms</th>
                          <th className="px-2 py-1.5 text-right font-medium">max ms</th>
                        </tr>
                      </thead>
                      <tbody>
                        {perf.perChannel.map((c, i) => (
                          <tr key={i} className="border-t border-border/40">
                            <td className="px-2 py-1.5">{c.name ?? `#${c.channelId}`}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{c.calls}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{c.avgMs}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{c.maxMs}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </>
            ) : (
              <p className="text-xs text-muted">{t("common.loading")}</p>
            )}
          </section>
        )}

        {/* 通用 KV fallback —— 让 Root 直接改任意键 */}
        <details className="rounded-2xl border border-border bg-surface/60 p-4 backdrop-blur-xl">
          <summary className="cursor-pointer text-xs text-muted hover:text-text">
            {t("sysadv.rawKv")}
          </summary>
          <RawKvEditor />
        </details>
      </div>
    </div>
  );
}

function Row({
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
      <Switch checked={checked} onChange={onChange} />
    </label>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface-2/40 p-3 text-center">
      <p className="text-[10px] uppercase tracking-wider text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

/** 终极通用编辑：列出所有 config_kv 并允许 raw JSON 编辑（仅 root 用） */
function RawKvEditor() {
  const t = useT();
  const [items, setItems] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void apiGet<{ config: Record<string, unknown> }>("/api/admin/config")
      .then((r) => {
        const out: Record<string, string> = {};
        for (const k in r.config) out[k] = JSON.stringify(r.config[k], null, 2);
        setItems(out);
      })
      .catch(() => {});
  }, []);

  const saveOne = async (k: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(items[k] ?? "");
    } catch (e: any) {
      notify("error", "JSON 无效", e?.message);
      return;
    }
    setSaving(true);
    try {
      await apiPatch("/api/admin/config", { [k]: parsed });
      notify("success", t("common.saved"));
    } catch (e: any) {
      notify("error", t("common.saveFail"), e?.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 space-y-3">
      {Object.entries(items).map(([k, v]) => (
        <div key={k} className="rounded-xl border border-border/40 bg-surface-2/30 p-3">
          <div className="mb-1 flex items-center justify-between">
            <code className="text-[11px] font-semibold">{k}</code>
            <Button size="sm" variant="ghost" onClick={() => void saveOne(k)} disabled={saving}>
              <Save className="h-3 w-3" />
            </Button>
          </div>
          <JsonEditor
            value={v}
            onChange={(nv) => setItems((s) => ({ ...s, [k]: nv }))}
            rows={4}
          />
        </div>
      ))}
    </div>
  );
}

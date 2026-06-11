import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Trophy,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { TextField } from "@/components/ui/TextField";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/services/apiClient";
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
  sortOrder: number;
  features: Record<string, unknown> | null;
}

interface TierForm {
  code: string;
  displayName: string;
  priceUsd: string;
  quota5hUsd: string;
  quota7dUsd: string;
  multiplier: string;
  sortOrder: string;
  enabled: boolean;
  featuresText: string;
}

const EMPTY_FORM: TierForm = {
  code: "",
  displayName: "",
  priceUsd: "0",
  quota5hUsd: "0",
  quota7dUsd: "0",
  multiplier: "1",
  sortOrder: "100",
  enabled: true,
  featuresText: "{}",
};

function tierToForm(t: Tier): TierForm {
  return {
    code: t.code,
    displayName: t.displayName,
    priceUsd: String(t.priceUsd),
    quota5hUsd: String(t.quota5hUsd),
    quota7dUsd: String(t.quota7dUsd),
    multiplier: String(t.multiplier),
    sortOrder: String(t.sortOrder),
    enabled: !!t.enabled,
    featuresText: t.features ? JSON.stringify(t.features, null, 2) : "{}",
  };
}

export function TierManager() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 12 });
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Tier | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<TierForm>(EMPTY_FORM);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await apiGet<{ tiers: Tier[] }>("/api/admin/tiers");
      setTiers(d.tiers);
    } catch (e: any) {
      notify("error", t("common.loadFail"), e?.message);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const dialogOpen = creating || !!editing;

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setFormErr(null);
    setCreating(true);
  };

  const openEdit = (tier: Tier) => {
    setForm(tierToForm(tier));
    setFormErr(null);
    setEditing(tier);
  };

  const closeDialog = () => {
    setCreating(false);
    setEditing(null);
    setSaving(false);
    setFormErr(null);
  };

  const buildBody = (): {
    body: Record<string, unknown> | null;
    error: string | null;
  } => {
    if (!form.displayName.trim())
      return { body: null, error: t("admin.tiers.err.nameEmpty") };
    if (creating && !form.code.trim())
      return { body: null, error: t("admin.tiers.err.codeEmpty") };
    const numericFields: [keyof TierForm, string, number?][] = [
      ["priceUsd", "price", 0],
      ["quota5hUsd", "quota5h", 0],
      ["quota7dUsd", "quota7d", 0],
      ["multiplier", "multiplier", 0],
      ["sortOrder", "sortOrder"],
    ];
    const parsed: Record<string, number> = {};
    for (const [key, outKey, min] of numericFields) {
      const n = Number(form[key]);
      if (!Number.isFinite(n))
        return {
          body: null,
          error: t("admin.tiers.err.numberInvalid", { field: outKey }),
        };
      if (min !== undefined && n < min)
        return {
          body: null,
          error: t("admin.tiers.err.numberRange", { field: outKey }),
        };
      parsed[outKey] = n;
    }
    if (parsed.multiplier <= 0)
      return { body: null, error: t("admin.tiers.err.multiplierZero") };
    let features: unknown = null;
    const ft = form.featuresText.trim();
    if (ft) {
      try {
        features = JSON.parse(ft);
      } catch {
        return { body: null, error: t("admin.tiers.err.featuresJson") };
      }
    }
    const body: Record<string, unknown> = {
      displayName: form.displayName.trim(),
      priceUsd: parsed.price,
      quota5hUsd: parsed.quota5h,
      quota7dUsd: parsed.quota7d,
      multiplier: parsed.multiplier,
      sortOrder: parsed.sortOrder,
      enabled: form.enabled,
      features,
    };
    if (creating) body.code = form.code.trim().toLowerCase();
    return { body, error: null };
  };

  const submit = async () => {
    const { body, error } = buildBody();
    if (error || !body) {
      setFormErr(error);
      return;
    }
    setSaving(true);
    setFormErr(null);
    try {
      if (editing) {
        await apiPatch(`/api/admin/tiers/${editing.id}`, body);
        notify("success", t("admin.tiers.saved", { name: editing.displayName }));
      } else {
        await apiPost("/api/admin/tiers", body);
        notify("success", t("admin.tiers.created"));
      }
      closeDialog();
      await load();
    } catch (e: any) {
      setFormErr(e?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (tier: Tier, next: boolean) => {
    const prev = !!tier.enabled;
    setTiers((list) =>
      list.map((x) => (x.id === tier.id ? { ...x, enabled: next ? 1 : 0 } : x)),
    );
    try {
      await apiPatch(`/api/admin/tiers/${tier.id}`, {
        displayName: tier.displayName,
        priceUsd: Number(tier.priceUsd),
        quota5hUsd: Number(tier.quota5hUsd),
        quota7dUsd: Number(tier.quota7dUsd),
        multiplier: Number(tier.multiplier),
        sortOrder: tier.sortOrder,
        enabled: next,
        features: tier.features,
      });
    } catch (e: any) {
      setTiers((list) =>
        list.map((x) =>
          x.id === tier.id ? { ...x, enabled: prev ? 1 : 0 } : x,
        ),
      );
      notify("error", t("common.saveFail"), e?.message);
    }
  };

  const onDelete = async (tier: Tier) => {
    const ok = await confirm({
      title: t("admin.tiers.delTitle", { name: tier.displayName }),
      description: t("admin.tiers.delDesc"),
      level: "critical",
      confirmText: tier.code,
    });
    if (!ok) return;
    setDeletingId(tier.id);
    try {
      await apiDelete(`/api/admin/tiers/${tier.id}`);
      notify("success", t("admin.tiers.delDone"));
      await load();
    } catch (e: any) {
      notify("error", t("admin.tiers.delFail"), e?.message);
    } finally {
      setDeletingId(null);
    }
  };

  const dialogTitle = useMemo(
    () =>
      editing
        ? t("admin.tiers.editTitle", { name: editing.displayName })
        : t("admin.tiers.createTitle"),
    [editing, t],
  );

  return (
    <div ref={ref} className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">{t("admin.tiers.title")}</h1>
            <p className="mt-1 text-sm text-muted">
              {t("admin.tiers.subtitle")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void load()}
              disabled={loading}
            >
              <RefreshCw
                className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"}
              />
              {t("common.refresh")}
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" />
              {t("admin.tiers.create")}
            </Button>
          </div>
        </header>

        {tiers.length === 0 && !loading ? (
          <div className="grid place-items-center rounded-2xl border border-dashed border-border bg-surface/40 py-16 text-sm text-muted">
            {t("admin.tiers.empty")}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {tiers.map((tier) => (
              <div
                key={tier.id}
                className="group space-y-3 rounded-2xl border border-border bg-surface/60 p-5 shadow-soft backdrop-blur-xl transition hover:border-primary/30"
              >
                <div className="flex items-center gap-2">
                  <Trophy className="h-4 w-4 text-primary" />
                  <span className="text-sm font-semibold">
                    {tier.displayName}
                  </span>
                  <span className="ml-auto rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[10px] text-muted">
                    {tier.code}
                  </span>
                </div>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                  <div>
                    <dt className="text-muted">{t("admin.tiers.price")}</dt>
                    <dd className="font-mono">${tier.priceUsd}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">{t("admin.tiers.multiplier")}</dt>
                    <dd className="font-mono">×{tier.multiplier}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">{t("admin.tiers.quota5h")}</dt>
                    <dd className="font-mono">${tier.quota5hUsd}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">{t("admin.tiers.quota7d")}</dt>
                    <dd className="font-mono">${tier.quota7dUsd}</dd>
                  </div>
                </dl>
                <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-3">
                  <label className="flex items-center gap-2 text-xs text-muted">
                    <Switch
                      checked={!!tier.enabled}
                      onChange={(v) => void toggleEnabled(tier, v)}
                      label={t("admin.tiers.enabled")}
                    />
                    {t("admin.tiers.enabled")}
                  </label>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => openEdit(tier)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      {t("common.edit")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void onDelete(tier)}
                      loading={deletingId === tier.id}
                      className="text-danger hover:bg-danger/10"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {t("common.delete")}
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal
        open={dialogOpen}
        onClose={closeDialog}
        title={dialogTitle}
        description={
          editing
            ? t("admin.tiers.editDesc", { code: editing.code })
            : t("admin.tiers.createDesc")
        }
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={closeDialog} disabled={saving}>
              {t("confirm.cancel")}
            </Button>
            <Button onClick={() => void submit()} loading={saving}>
              <Save className="h-3.5 w-3.5" />
              {editing ? t("common.save") : t("admin.tiers.create")}
            </Button>
          </>
        }
      >
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <TextField
              label={t("admin.tiers.code")}
              value={form.code}
              onChange={(e) =>
                setForm((s) => ({ ...s, code: e.target.value.toLowerCase() }))
              }
              placeholder={t("admin.tiers.code.ph")}
              disabled={!!editing}
              hint={editing ? t("admin.tiers.codeLocked") : undefined}
              className="font-mono"
              required
              autoFocus
            />
            <TextField
              label={t("admin.tiers.displayName")}
              value={form.displayName}
              onChange={(e) =>
                setForm((s) => ({ ...s, displayName: e.target.value }))
              }
              placeholder={t("admin.tiers.displayName.ph")}
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <TextField
              label={t("admin.tiers.price")}
              type="number"
              value={form.priceUsd}
              onChange={(e) =>
                setForm((s) => ({ ...s, priceUsd: e.target.value }))
              }
              placeholder="0"
              required
            />
            <TextField
              label={t("admin.tiers.multiplier")}
              type="number"
              value={form.multiplier}
              onChange={(e) =>
                setForm((s) => ({ ...s, multiplier: e.target.value }))
              }
              placeholder="1"
              required
            />
            <TextField
              label={t("admin.tiers.quota5h")}
              type="number"
              value={form.quota5hUsd}
              onChange={(e) =>
                setForm((s) => ({ ...s, quota5hUsd: e.target.value }))
              }
              placeholder="0"
              required
            />
            <TextField
              label={t("admin.tiers.quota7d")}
              type="number"
              value={form.quota7dUsd}
              onChange={(e) =>
                setForm((s) => ({ ...s, quota7dUsd: e.target.value }))
              }
              placeholder="0"
              required
            />
            <TextField
              label={t("admin.tiers.sortOrder")}
              type="number"
              value={form.sortOrder}
              onChange={(e) =>
                setForm((s) => ({ ...s, sortOrder: e.target.value }))
              }
              placeholder="100"
              hint={t("admin.tiers.sortOrder.hint")}
            />
            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2 text-xs text-muted">
                <Switch
                  checked={form.enabled}
                  onChange={(v) => setForm((s) => ({ ...s, enabled: v }))}
                  label={t("admin.tiers.enabled")}
                />
                {t("admin.tiers.enabled")}
              </label>
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted">
              {t("admin.tiers.features")}
            </label>
            <textarea
              value={form.featuresText}
              onChange={(e) =>
                setForm((s) => ({ ...s, featuresText: e.target.value }))
              }
              placeholder={t("admin.tiers.features.ph")}
              rows={5}
              className={
                "w-full rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 font-mono text-xs " +
                "leading-relaxed outline-none transition-[box-shadow,border-color] no-drag " +
                "focus:border-primary/60 focus:shadow-[0_0_0_3px_rgb(var(--primary)/0.18)]"
              }
              spellCheck={false}
            />
            <p className="text-[11px] text-muted/80">
              {t("admin.tiers.features.hint")}
            </p>
          </div>
          {formErr && (
            <div className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
              {formErr}
            </div>
          )}
        </form>
      </Modal>
    </div>
  );
}

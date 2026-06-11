import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Coins,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
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

interface Model {
  id: number;
  name: string;
  displayName: string | null;
  family: string | null;
  promptPricePerMillion: string;
  completionPricePerMillion: string;
  contextWindow: number | null;
  enabled: number;
  sortOrder: number;
}

interface Form {
  name: string;
  displayName: string;
  family: string;
  promptPricePerMillion: string;
  completionPricePerMillion: string;
  contextWindow: string;
  enabled: boolean;
  sortOrder: string;
}

const EMPTY: Form = {
  name: "",
  displayName: "",
  family: "",
  promptPricePerMillion: "3",
  completionPricePerMillion: "15",
  contextWindow: "",
  enabled: true,
  sortOrder: "100",
};

function toForm(m: Model): Form {
  return {
    name: m.name,
    displayName: m.displayName ?? "",
    family: m.family ?? "",
    promptPricePerMillion: String(m.promptPricePerMillion),
    completionPricePerMillion: String(m.completionPricePerMillion),
    contextWindow: m.contextWindow != null ? String(m.contextWindow) : "",
    enabled: !!m.enabled,
    sortOrder: String(m.sortOrder),
  };
}

export function ModelManager() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 12 });
  const [list, setList] = useState<Model[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Model | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<Form>(EMPTY);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiGet<{ models: Model[] }>("/api/admin/models");
      setList(r.models);
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
  const title = useMemo(
    () =>
      editing
        ? t("model.editTitle", { name: editing.displayName ?? editing.name })
        : t("model.createTitle"),
    [editing, t],
  );

  const openCreate = () => {
    setForm(EMPTY);
    setFormErr(null);
    setCreating(true);
  };
  const openEdit = (m: Model) => {
    setForm(toForm(m));
    setFormErr(null);
    setEditing(m);
  };
  const closeDialog = () => {
    setCreating(false);
    setEditing(null);
    setSaving(false);
  };

  const build = (): { body: Record<string, unknown> | null; error: string | null } => {
    if (creating && !form.name.trim())
      return { body: null, error: t("model.err.nameEmpty") };
    const p = Number(form.promptPricePerMillion);
    const c = Number(form.completionPricePerMillion);
    if (!Number.isFinite(p) || !Number.isFinite(c) || p < 0 || c < 0)
      return { body: null, error: t("model.err.priceInvalid") };
    const cw = form.contextWindow.trim() ? Number(form.contextWindow) : null;
    if (cw !== null && (!Number.isFinite(cw) || cw <= 0))
      return { body: null, error: t("model.err.ctxInvalid") };
    const so = Number(form.sortOrder);
    const body: Record<string, unknown> = {
      displayName: form.displayName.trim() || null,
      family: form.family.trim() || null,
      promptPricePerMillion: p,
      completionPricePerMillion: c,
      contextWindow: cw,
      enabled: form.enabled,
      sortOrder: Number.isFinite(so) ? so : 100,
    };
    if (creating) body.name = form.name.trim();
    return { body, error: null };
  };

  const submit = async () => {
    const { body, error } = build();
    if (error || !body) {
      setFormErr(error);
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await apiPatch(`/api/admin/models/${editing.id}`, body);
        notify("success", t("model.saved"));
      } else {
        await apiPost("/api/admin/models", body);
        notify("success", t("model.created"));
      }
      closeDialog();
      await load();
    } catch (e: any) {
      setFormErr(e?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async (m: Model) => {
    const ok = await confirm({
      title: t("model.delTitle", { name: m.name }),
      description: t("model.delDesc"),
      level: "critical",
      confirmText: m.name,
    });
    if (!ok) return;
    try {
      await apiDelete(`/api/admin/models/${m.id}`);
      notify("success", t("model.delDone"));
      await load();
    } catch (e: any) {
      notify("error", t("model.delFail"), e?.message);
    }
  };

  const toggleEnabled = async (m: Model, next: boolean) => {
    const prev = !!m.enabled;
    setList((xs) =>
      xs.map((x) => (x.id === m.id ? { ...x, enabled: next ? 1 : 0 } : x)),
    );
    try {
      await apiPatch(`/api/admin/models/${m.id}`, {
        displayName: m.displayName,
        family: m.family,
        promptPricePerMillion: Number(m.promptPricePerMillion),
        completionPricePerMillion: Number(m.completionPricePerMillion),
        contextWindow: m.contextWindow,
        enabled: next,
        sortOrder: m.sortOrder,
      });
    } catch (e: any) {
      setList((xs) =>
        xs.map((x) => (x.id === m.id ? { ...x, enabled: prev ? 1 : 0 } : x)),
      );
      notify("error", t("common.saveFail"), e?.message);
    }
  };

  return (
    <div ref={ref} className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">{t("model.title")}</h1>
            <p className="mt-1 text-sm text-muted">{t("model.subtitle")}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
              {t("common.refresh")}
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" />
              {t("model.create")}
            </Button>
          </div>
        </header>

        {list.length === 0 && !loading ? (
          <div className="grid place-items-center rounded-2xl border border-dashed border-border bg-surface/40 py-16 text-sm text-muted">
            {t("model.empty")}
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-border bg-surface/60 backdrop-blur-xl">
            <table className="w-full text-sm">
              <thead className="bg-surface-2/60 text-xs text-muted">
                <tr>
                  <th className="px-3 py-2.5 text-left">{t("model.col.name")}</th>
                  <th className="px-3 py-2.5 text-left">{t("model.col.family")}</th>
                  <th className="px-3 py-2.5 text-right">{t("model.col.in")}</th>
                  <th className="px-3 py-2.5 text-right">{t("model.col.out")}</th>
                  <th className="px-3 py-2.5 text-right">{t("model.col.ctx")}</th>
                  <th className="px-3 py-2.5 text-left">{t("model.col.enabled")}</th>
                  <th className="px-3 py-2.5 text-right">{t("model.col.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((m) => (
                  <tr key={m.id} className="border-t border-border/60 hover:bg-surface-2/30">
                    <td className="px-3 py-2.5">
                      <div className="font-mono text-xs">{m.name}</div>
                      {m.displayName && (
                        <div className="text-[11px] text-muted">{m.displayName}</div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs">{m.family ?? "-"}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      ${Number(m.promptPricePerMillion).toFixed(2)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      ${Number(m.completionPricePerMillion).toFixed(2)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {m.contextWindow != null ? m.contextWindow.toLocaleString() : "-"}
                    </td>
                    <td className="px-3 py-2.5">
                      <Switch
                        checked={!!m.enabled}
                        onChange={(v) => void toggleEnabled(m, v)}
                      />
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => openEdit(m)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void onDelete(m)}
                          className="text-danger hover:bg-danger/10"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal
        open={dialogOpen}
        onClose={closeDialog}
        title={title}
        description={editing ? t("model.editDesc") : t("model.createDesc")}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={closeDialog} disabled={saving}>
              {t("confirm.cancel")}
            </Button>
            <Button onClick={() => void submit()} loading={saving}>
              <Save className="h-3.5 w-3.5" />
              {editing ? t("common.save") : t("model.create")}
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
              label={t("model.name")}
              value={form.name}
              onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
              placeholder="claude-3-5-sonnet-20241022"
              hint={editing ? t("model.nameLocked") : undefined}
              disabled={!!editing}
              required
              autoFocus
            />
            <TextField
              label={t("model.family")}
              value={form.family}
              onChange={(e) => setForm((s) => ({ ...s, family: e.target.value }))}
              placeholder="anthropic / openai / gemini"
            />
          </div>
          <TextField
            label={t("model.displayName")}
            value={form.displayName}
            onChange={(e) => setForm((s) => ({ ...s, displayName: e.target.value }))}
            placeholder="Claude 3.5 Sonnet"
          />
          <div className="grid grid-cols-2 gap-3">
            <TextField
              label={t("model.priceInput")}
              type="number"
              value={form.promptPricePerMillion}
              onChange={(e) =>
                setForm((s) => ({ ...s, promptPricePerMillion: e.target.value }))
              }
              hint="USD / 1M"
              required
            />
            <TextField
              label={t("model.priceOutput")}
              type="number"
              value={form.completionPricePerMillion}
              onChange={(e) =>
                setForm((s) => ({ ...s, completionPricePerMillion: e.target.value }))
              }
              hint="USD / 1M"
              required
            />
            <TextField
              label={t("model.contextWindow")}
              type="number"
              value={form.contextWindow}
              onChange={(e) => setForm((s) => ({ ...s, contextWindow: e.target.value }))}
              placeholder="200000"
            />
            <TextField
              label={t("model.sortOrder")}
              type="number"
              value={form.sortOrder}
              onChange={(e) => setForm((s) => ({ ...s, sortOrder: e.target.value }))}
              placeholder="100"
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-muted">
            <Switch
              checked={form.enabled}
              onChange={(v) => setForm((s) => ({ ...s, enabled: v }))}
            />
            {t("model.enabled")}
          </label>
          {formErr && (
            <div className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
              {formErr}
            </div>
          )}
          <p className="flex items-start gap-2 rounded-xl border border-info/30 bg-info/5 px-3 py-2 text-[11px] text-muted">
            <Coins className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" />
            {t("model.tip")}
          </p>
        </form>
      </Modal>
    </div>
  );
}

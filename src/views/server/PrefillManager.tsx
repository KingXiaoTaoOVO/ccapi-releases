import { useCallback, useEffect, useState } from "react";
import { Layers, Pencil, Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { JsonEditor } from "@/components/ui/JsonEditor";
import { Modal } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { TextField } from "@/components/ui/TextField";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/services/apiClient";
import { notify } from "@/services/notify";
import { confirm } from "@/store/useConfirmStore";

interface Group {
  id: number;
  code: string;
  displayName: string;
  description: string | null;
  prompts: unknown;
  enabled: number;
  sortOrder: number;
}

interface Form {
  code: string;
  displayName: string;
  description: string;
  promptsText: string;
  enabled: boolean;
  sortOrder: string;
}

const EMPTY: Form = {
  code: "",
  displayName: "",
  description: "",
  promptsText:
    '[\n  {"role": "system", "content": "You are a helpful assistant."},\n  {"role": "user", "content": ""}\n]',
  enabled: true,
  sortOrder: "0",
};

export function PrefillManager() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 12 });
  const [list, setList] = useState<Group[]>([]);
  const [editing, setEditing] = useState<Group | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<Form>(EMPTY);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await apiGet<{ groups: Group[] }>("/api/prefill-groups");
      setList(r.groups);
    } catch (e: any) {
      notify("error", t("common.loadFail"), e?.message);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    let prompts: unknown;
    try {
      prompts = JSON.parse(form.promptsText);
    } catch (e: any) {
      notify("error", "prompts JSON 无效", e?.message);
      return;
    }
    setSaving(true);
    try {
      const body = {
        code: form.code.trim(),
        displayName: form.displayName.trim(),
        description: form.description || null,
        prompts,
        enabled: form.enabled,
        sortOrder: Number(form.sortOrder) || 0,
      };
      if (editing) {
        await apiPatch(`/api/admin/prefill-groups/${editing.id}`, body);
      } else {
        await apiPost("/api/admin/prefill-groups", body);
      }
      notify("success", t("common.saved"));
      setCreating(false);
      setEditing(null);
      await load();
    } catch (e: any) {
      notify("error", t("common.saveFail"), e?.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (g: Group) => {
    const ok = await confirm({
      title: t("prefill.del.title", { name: g.displayName }),
      level: "danger",
    });
    if (!ok) return;
    try {
      await apiDelete(`/api/admin/prefill-groups/${g.id}`);
      await load();
    } catch (e: any) {
      notify("error", t("common.delFail"), e?.message);
    }
  };

  const openCreate = () => {
    setForm(EMPTY);
    setCreating(true);
  };
  const openEdit = (g: Group) => {
    setForm({
      code: g.code,
      displayName: g.displayName,
      description: g.description ?? "",
      promptsText: JSON.stringify(g.prompts, null, 2),
      enabled: !!g.enabled,
      sortOrder: String(g.sortOrder),
    });
    setEditing(g);
  };

  return (
    <div ref={ref} className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="flex items-end justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <Layers className="h-5 w-5 text-primary" />
              {t("prefill.title")}
            </h1>
            <p className="mt-1 text-sm text-muted">{t("prefill.subtitle")}</p>
          </div>
          <Button onClick={openCreate}>
            <Plus className="h-3.5 w-3.5" />
            {t("prefill.create")}
          </Button>
        </header>

        {list.length === 0 ? (
          <div className="grid place-items-center rounded-2xl border border-dashed border-border bg-surface/40 py-16 text-sm text-muted">
            {t("prefill.empty")}
          </div>
        ) : (
          <div className="space-y-2">
            {list.map((g) => (
              <div
                key={g.id}
                className="flex items-center gap-3 rounded-2xl border border-border bg-surface/60 p-3 backdrop-blur-xl"
              >
                <Layers className="h-5 w-5 text-muted" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{g.displayName}</p>
                  <p className="font-mono text-[10px] text-muted">{g.code}</p>
                  {g.description && (
                    <p className="mt-0.5 truncate text-[11px] text-muted">{g.description}</p>
                  )}
                </div>
                <span className="text-[10px] text-muted">
                  {Array.isArray(g.prompts) ? `${(g.prompts as unknown[]).length} msgs` : ""}
                </span>
                <Button size="sm" variant="ghost" onClick={() => openEdit(g)}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void remove(g)}
                  className="text-danger hover:bg-danger/10"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal
        open={creating || !!editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        title={editing ? t("prefill.edit", { name: editing.displayName }) : t("prefill.create")}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setCreating(false); setEditing(null); }}>
              {t("confirm.cancel")}
            </Button>
            <Button onClick={() => void submit()} loading={saving}>
              <Save className="h-3.5 w-3.5" />
              {t("common.save")}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <TextField
              label={t("prefill.code")}
              value={form.code}
              onChange={(e) => setForm((s) => ({ ...s, code: e.target.value }))}
              placeholder="coding-assistant"
              disabled={!!editing}
            />
            <TextField
              label={t("prefill.displayName")}
              value={form.displayName}
              onChange={(e) => setForm((s) => ({ ...s, displayName: e.target.value }))}
              placeholder="编程助手"
            />
          </div>
          <TextField
            label={t("prefill.description")}
            value={form.description}
            onChange={(e) => setForm((s) => ({ ...s, description: e.target.value }))}
          />
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">
              {t("prefill.prompts")}
            </label>
            <JsonEditor
              value={form.promptsText}
              onChange={(v) => setForm((s) => ({ ...s, promptsText: v }))}
              rows={10}
              hint={t("prefill.prompts.hint")}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <TextField
              label={t("prefill.sortOrder")}
              type="number"
              value={form.sortOrder}
              onChange={(e) => setForm((s) => ({ ...s, sortOrder: e.target.value }))}
            />
            <label className="flex items-end gap-2 pb-2 text-xs text-muted">
              <Switch
                checked={form.enabled}
                onChange={(v) => setForm((s) => ({ ...s, enabled: v }))}
              />
              {t("common.enabled")}
            </label>
          </div>
        </div>
      </Modal>
    </div>
  );
}

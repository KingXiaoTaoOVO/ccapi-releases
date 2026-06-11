import { useCallback, useEffect, useMemo, useState } from "react";
import { Pencil, Plus, RefreshCw, Save, Trash2, Users } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
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
  multiplier: string;
  description: string | null;
}

interface Form {
  code: string;
  displayName: string;
  multiplier: string;
  description: string;
}

const EMPTY: Form = {
  code: "",
  displayName: "",
  multiplier: "1",
  description: "",
};

export function UserGroupManager() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 12 });
  const [list, setList] = useState<Group[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Group | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<Form>(EMPTY);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiGet<{ groups: Group[] }>("/api/admin/user-groups");
      setList(r.groups);
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
        ? t("group.editTitle", { name: editing.displayName })
        : t("group.createTitle"),
    [editing, t],
  );

  const openCreate = () => {
    setForm(EMPTY);
    setFormErr(null);
    setCreating(true);
  };
  const openEdit = (g: Group) => {
    setForm({
      code: g.code,
      displayName: g.displayName,
      multiplier: String(g.multiplier),
      description: g.description ?? "",
    });
    setFormErr(null);
    setEditing(g);
  };
  const closeDialog = () => {
    setCreating(false);
    setEditing(null);
    setSaving(false);
  };

  const submit = async () => {
    if (!form.displayName.trim()) {
      setFormErr(t("group.err.nameEmpty"));
      return;
    }
    const m = Number(form.multiplier);
    if (!Number.isFinite(m) || m <= 0) {
      setFormErr(t("group.err.multiplier"));
      return;
    }
    if (creating && !form.code.trim()) {
      setFormErr(t("group.err.codeEmpty"));
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        displayName: form.displayName.trim(),
        multiplier: m,
        description: form.description.trim() || null,
      };
      if (creating) body.code = form.code.trim();
      if (editing) {
        await apiPatch(`/api/admin/user-groups/${editing.id}`, body);
        notify("success", t("group.saved"));
      } else {
        await apiPost("/api/admin/user-groups", body);
        notify("success", t("group.created"));
      }
      closeDialog();
      await load();
    } catch (e: any) {
      setFormErr(e?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async (g: Group) => {
    if (g.id === 1) {
      notify("error", t("group.cannotDelDefault"));
      return;
    }
    const ok = await confirm({
      title: t("group.delTitle", { name: g.displayName }),
      description: t("group.delDesc"),
      level: "critical",
      confirmText: g.code,
    });
    if (!ok) return;
    try {
      await apiDelete(`/api/admin/user-groups/${g.id}`);
      notify("success", t("group.delDone"));
      await load();
    } catch (e: any) {
      notify("error", t("group.delFail"), e?.message);
    }
  };

  return (
    <div ref={ref} className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">{t("group.title")}</h1>
            <p className="mt-1 text-sm text-muted">{t("group.subtitle")}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
              {t("common.refresh")}
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" />
              {t("group.create")}
            </Button>
          </div>
        </header>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {list.map((g) => (
            <div
              key={g.id}
              className="space-y-3 rounded-2xl border border-border bg-surface/60 p-5 shadow-soft backdrop-blur-xl"
            >
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-primary" />
                <span className="text-sm font-semibold">{g.displayName}</span>
                <span className="ml-auto rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[10px] text-muted">
                  {g.code}
                </span>
              </div>
              <p className="text-2xl font-semibold tabular-nums">
                ×{Number(g.multiplier).toFixed(2)}
              </p>
              <p className="min-h-[1.5em] text-xs text-muted">
                {g.description ?? t("group.noDesc")}
              </p>
              <div className="flex justify-end gap-1 border-t border-border/60 pt-2">
                <Button size="sm" variant="ghost" onClick={() => openEdit(g)}>
                  <Pencil className="h-3.5 w-3.5" />
                  {t("common.edit")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void onDelete(g)}
                  disabled={g.id === 1}
                  className="text-danger hover:bg-danger/10"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("common.delete")}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <Modal
        open={dialogOpen}
        onClose={closeDialog}
        title={title}
        description={editing ? t("group.editDesc") : t("group.createDesc")}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={closeDialog} disabled={saving}>
              {t("confirm.cancel")}
            </Button>
            <Button onClick={() => void submit()} loading={saving}>
              <Save className="h-3.5 w-3.5" />
              {editing ? t("common.save") : t("group.create")}
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
              label={t("group.code")}
              value={form.code}
              onChange={(e) =>
                setForm((s) => ({ ...s, code: e.target.value.toLowerCase() }))
              }
              placeholder="default / vip / enterprise"
              disabled={!!editing}
              hint={editing ? t("group.codeLocked") : undefined}
              required
              autoFocus
            />
            <TextField
              label={t("group.displayName")}
              value={form.displayName}
              onChange={(e) => setForm((s) => ({ ...s, displayName: e.target.value }))}
              placeholder="VIP 用户 / 默认分组"
              required
            />
          </div>
          <TextField
            label={t("group.multiplier")}
            type="number"
            value={form.multiplier}
            onChange={(e) => setForm((s) => ({ ...s, multiplier: e.target.value }))}
            placeholder="1.0"
            hint={t("group.multiplier.hint")}
            required
          />
          <TextField
            label={t("group.description")}
            value={form.description}
            onChange={(e) => setForm((s) => ({ ...s, description: e.target.value }))}
            placeholder={t("group.description.ph")}
          />
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

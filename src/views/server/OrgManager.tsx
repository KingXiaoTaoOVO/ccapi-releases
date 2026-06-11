import { useCallback, useEffect, useState } from "react";
import { Building2, Pencil, Plus, Save, Trash2, Users } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { TextField } from "@/components/ui/TextField";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/services/apiClient";
import { notify } from "@/services/notify";
import { confirm } from "@/store/useConfirmStore";

interface Org {
  id: number;
  name: string;
  displayName: string;
  ownerUserId: number;
  billingEmail: string | null;
  status: "active" | "disabled";
  description: string | null;
  createdAt: string | null;
}

interface Member {
  id: number;
  orgId: number;
  userId: number;
  username: string;
  role: "owner" | "admin" | "member";
  createdAt: string | null;
}

interface Form {
  name: string;
  displayName: string;
  ownerUserId: string;
  billingEmail: string;
  status: "active" | "disabled";
  description: string;
}

const EMPTY: Form = {
  name: "",
  displayName: "",
  ownerUserId: "",
  billingEmail: "",
  status: "active",
  description: "",
};

export function OrgManager() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 12 });
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [editing, setEditing] = useState<Org | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<Form>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [membersFor, setMembersFor] = useState<Org | null>(null);
  const [members, setMembers] = useState<Member[]>([]);

  const load = useCallback(async () => {
    try {
      const r = await apiGet<{ orgs: Org[] }>("/api/admin/orgs");
      setOrgs(r.orgs);
    } catch (e: any) {
      notify("error", t("common.loadFail"), e?.message);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setForm(EMPTY);
    setCreating(true);
  };
  const openEdit = (o: Org) => {
    setForm({
      name: o.name,
      displayName: o.displayName,
      ownerUserId: String(o.ownerUserId),
      billingEmail: o.billingEmail ?? "",
      status: o.status,
      description: o.description ?? "",
    });
    setEditing(o);
  };
  const close = () => {
    setCreating(false);
    setEditing(null);
  };

  const submit = async () => {
    if (!form.name.trim() || !form.displayName.trim()) {
      notify("error", t("orgs.err.required"));
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: form.name.trim(),
        displayName: form.displayName.trim(),
        ownerUserId: form.ownerUserId ? Number(form.ownerUserId) : null,
        billingEmail: form.billingEmail || null,
        status: form.status,
        description: form.description || null,
      };
      if (editing) {
        await apiPatch(`/api/admin/orgs/${editing.id}`, body);
      } else {
        await apiPost("/api/admin/orgs", body);
      }
      notify("success", t("common.saved"));
      close();
      await load();
    } catch (e: any) {
      notify("error", t("common.saveFail"), e?.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (o: Org) => {
    const ok = await confirm({
      title: t("orgs.del.title", { name: o.displayName }),
      level: "critical",
      confirmText: o.name,
    });
    if (!ok) return;
    try {
      await apiDelete(`/api/admin/orgs/${o.id}`);
      await load();
    } catch (e: any) {
      notify("error", t("common.delFail"), e?.message);
    }
  };

  const loadMembers = async (o: Org) => {
    setMembersFor(o);
    try {
      const r = await apiGet<{ members: Member[] }>(
        `/api/admin/orgs/${o.id}/members`,
      );
      setMembers(r.members);
    } catch (e: any) {
      notify("error", t("common.loadFail"), e?.message);
    }
  };

  const addMember = async () => {
    if (!membersFor) return;
    const uidStr = window.prompt(t("orgs.member.uidPrompt"));
    if (!uidStr) return;
    const uid = Number(uidStr);
    if (!Number.isFinite(uid) || uid <= 0) {
      notify("error", t("orgs.member.uidInvalid"));
      return;
    }
    try {
      await apiPost(`/api/admin/orgs/${membersFor.id}/members`, {
        userId: uid,
        role: "member",
      });
      await loadMembers(membersFor);
    } catch (e: any) {
      notify("error", t("common.saveFail"), e?.message);
    }
  };

  const changeRole = async (m: Member, role: Member["role"]) => {
    try {
      await apiPatch(`/api/admin/orgs/${m.orgId}/members/${m.userId}`, { role });
      if (membersFor) await loadMembers(membersFor);
    } catch (e: any) {
      notify("error", t("common.saveFail"), e?.message);
    }
  };

  const removeMember = async (m: Member) => {
    const ok = await confirm({
      title: t("orgs.member.del", { name: m.username }),
      level: "danger",
    });
    if (!ok) return;
    try {
      await apiDelete(`/api/admin/orgs/${m.orgId}/members/${m.userId}`);
      if (membersFor) await loadMembers(membersFor);
    } catch (e: any) {
      notify("error", t("common.delFail"), e?.message);
    }
  };

  return (
    <div ref={ref} className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="flex items-end justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <Building2 className="h-5 w-5 text-primary" />
              {t("orgs.title")}
            </h1>
            <p className="mt-1 text-sm text-muted">{t("orgs.subtitle")}</p>
          </div>
          <Button onClick={openCreate}>
            <Plus className="h-3.5 w-3.5" />
            {t("orgs.create")}
          </Button>
        </header>

        {orgs.length === 0 ? (
          <div className="grid place-items-center rounded-2xl border border-dashed border-border bg-surface/40 py-16 text-sm text-muted">
            {t("orgs.empty")}
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-border bg-surface/60 backdrop-blur-xl">
            <table className="w-full text-sm">
              <thead className="bg-surface-2/60 text-xs text-muted">
                <tr>
                  <th className="px-3 py-2.5 text-left">{t("orgs.col.name")}</th>
                  <th className="px-3 py-2.5 text-left">{t("orgs.col.owner")}</th>
                  <th className="px-3 py-2.5 text-left">{t("orgs.col.status")}</th>
                  <th className="px-3 py-2.5 text-right">{t("orgs.col.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {orgs.map((o) => (
                  <tr key={o.id} className="border-t border-border/60">
                    <td className="px-3 py-2.5">
                      <p className="font-medium">{o.displayName}</p>
                      <p className="font-mono text-[10px] text-muted">{o.name}</p>
                    </td>
                    <td className="px-3 py-2.5 text-xs">#{o.ownerUserId}</td>
                    <td className="px-3 py-2.5">
                      <span
                        className={
                          "rounded-full px-2 py-0.5 text-[10px] " +
                          (o.status === "active"
                            ? "bg-success/15 text-success"
                            : "bg-muted/15 text-muted")
                        }
                      >
                        {o.status}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => void loadMembers(o)}>
                          <Users className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => openEdit(o)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void remove(o)}
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

      {/* 编辑 Modal */}
      <Modal
        open={creating || !!editing}
        onClose={close}
        title={editing ? t("orgs.edit", { name: editing.displayName }) : t("orgs.create")}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={close}>
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
          <TextField
            label={t("orgs.col.name")}
            value={form.name}
            onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
            placeholder="acme-corp"
            disabled={!!editing}
            hint={t("orgs.name.hint")}
          />
          <TextField
            label={t("orgs.displayName")}
            value={form.displayName}
            onChange={(e) => setForm((s) => ({ ...s, displayName: e.target.value }))}
            placeholder="Acme Corp"
          />
          <TextField
            label={t("orgs.ownerUserId")}
            type="number"
            value={form.ownerUserId}
            onChange={(e) => setForm((s) => ({ ...s, ownerUserId: e.target.value }))}
            hint={t("orgs.ownerUserId.hint")}
          />
          <TextField
            label={t("orgs.billingEmail")}
            value={form.billingEmail}
            onChange={(e) => setForm((s) => ({ ...s, billingEmail: e.target.value }))}
            placeholder="billing@example.com"
          />
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">
              {t("orgs.col.status")}
            </label>
            <Select
              value={form.status}
              onValueChange={(v) => setForm((s) => ({ ...s, status: v as Form["status"] }))}
              options={[
                { value: "active", label: t("common.enabled") },
                { value: "disabled", label: t("common.disabled") },
              ]}
            />
          </div>
          <TextField
            label={t("orgs.description")}
            value={form.description}
            onChange={(e) => setForm((s) => ({ ...s, description: e.target.value }))}
          />
        </div>
      </Modal>

      {/* 成员 Modal */}
      <Modal
        open={!!membersFor}
        onClose={() => setMembersFor(null)}
        title={t("orgs.members.title", { name: membersFor?.displayName ?? "" })}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setMembersFor(null)}>
              {t("confirm.close")}
            </Button>
            <Button onClick={() => void addMember()}>
              <Plus className="h-3.5 w-3.5" />
              {t("orgs.member.add")}
            </Button>
          </>
        }
      >
        {members.length === 0 ? (
          <p className="text-xs text-muted">{t("orgs.members.empty")}</p>
        ) : (
          <div className="space-y-2">
            {members.map((m) => (
              <div
                key={m.id}
                className="flex items-center gap-2 rounded-xl border border-border bg-surface-2/40 px-3 py-2"
              >
                <span className="flex-1 text-sm">
                  {m.username} <span className="text-[10px] text-muted">#{m.userId}</span>
                </span>
                <Select
                  value={m.role}
                  onValueChange={(v) => void changeRole(m, v as Member["role"])}
                  options={[
                    { value: "owner", label: "owner" },
                    { value: "admin", label: "admin" },
                    { value: "member", label: "member" },
                  ]}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void removeMember(m)}
                  className="text-danger hover:bg-danger/10"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}

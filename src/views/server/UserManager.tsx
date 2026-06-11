import { useCallback, useEffect, useState } from "react";
import {
  Ban,
  Check,
  KeyRound,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Snowflake,
  Trash2,
  UserPlus,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { TextField } from "@/components/ui/TextField";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { cn } from "@/lib/cn";
import { apiGet, apiPatch, apiPost, apiDelete } from "@/services/apiClient";
import { notify } from "@/services/notify";
import { confirm } from "@/store/useConfirmStore";
import { prompt } from "@/store/usePromptStore";

interface UserRow {
  id: number;
  username: string;
  roleId: number;
  roleName: string;
  status: "active" | "banned" | "frozen" | "pending";
  email: string | null;
  inviteCode: string | null;
  invitedBy: number | null;
  mustChangePassword: number;
  statusReason: string | null;
  statusUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string | null;
}

interface RoleRef {
  id: number;
  name: string;
}

const STATUS_TONE: Record<UserRow["status"], string> = {
  active: "bg-success/15 text-success",
  banned: "bg-danger/15 text-danger",
  frozen: "bg-info/15 text-info",
  pending: "bg-warning/15 text-warning",
};

export function UserManager() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 12 });
  const [users, setUsers] = useState<UserRow[]>([]);
  const [roles, setRoles] = useState<RoleRef[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [actioning, setActioning] = useState<{ id: number; action: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiGet<{ users: UserRow[] }>(
        `/api/admin/users?search=${encodeURIComponent(search)}`,
      );
      setUsers(data.users);
    } catch (e: any) {
      notify("error", "加载失败", e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [search]);

  const loadRoles = useCallback(async () => {
    try {
      const data = await apiGet<{ roles: { id: number; name: string }[] }>(
        "/api/admin/roles",
      );
      setRoles(data.roles.map((r) => ({ id: r.id, name: r.name })));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void loadRoles();
  }, [loadRoles]);

  const onBan = async (u: UserRow) => {
    const r = await prompt({
      title: t("admin.users.banTitle", { name: u.username }),
      description: t("admin.users.banDesc"),
      danger: true,
      confirmLabel: t("admin.users.banConfirm"),
      fields: [
        {
          name: "reason",
          label: t("admin.users.banReason"),
          placeholder: t("admin.users.banReason.ph"),
          type: "textarea",
          required: true,
        },
        {
          name: "hours",
          label: t("admin.users.banHours"),
          placeholder: t("admin.users.banHours.ph"),
          type: "number",
          defaultValue: "24",
        },
      ],
    });
    if (!r) return;
    const hours = Number(r.hours || "0");
    const seconds = hours <= 0 ? -1 : Math.floor(hours * 3600);
    setActioning({ id: u.id, action: "ban" });
    try {
      await apiPost(`/api/admin/users/${u.id}/ban`, {
        durationSecs: seconds,
        reason: r.reason,
      });
      notify("success", t("admin.users.banDone"));
      await load();
    } catch (e: any) {
      notify("error", "封禁失败", e?.message);
    } finally {
      setActioning(null);
    }
  };

  const onUnban = async (u: UserRow) => {
    setActioning({ id: u.id, action: "unban" });
    try {
      await apiPost(`/api/admin/users/${u.id}/unban`);
      notify("success", t("admin.users.unbanDone"));
      await load();
    } catch (e: any) {
      notify("error", "解封失败", e?.message);
    } finally {
      setActioning(null);
    }
  };

  const onFreeze = async (u: UserRow) => {
    const r = await prompt({
      title: t("admin.users.freezeTitle", { name: u.username }),
      danger: true,
      fields: [
        {
          name: "reason",
          label: t("admin.users.freezeReason"),
          placeholder: t("admin.users.freezeReason.ph"),
          type: "textarea",
          required: true,
        },
        {
          name: "hours",
          label: t("admin.users.freezeHours"),
          placeholder: t("admin.users.freezeHours.ph"),
          type: "number",
          defaultValue: "1",
        },
      ],
    });
    if (!r) return;
    const hours = Number(r.hours || "0");
    const seconds = hours <= 0 ? -1 : Math.floor(hours * 3600);
    setActioning({ id: u.id, action: "freeze" });
    try {
      await apiPost(`/api/admin/users/${u.id}/freeze`, {
        durationSecs: seconds,
        reason: r.reason,
      });
      notify("success", t("admin.users.freezeDone"));
      await load();
    } catch (e: any) {
      notify("error", "冻结失败", e?.message);
    } finally {
      setActioning(null);
    }
  };

  const onUnfreeze = async (u: UserRow) => {
    setActioning({ id: u.id, action: "unfreeze" });
    try {
      await apiPost(`/api/admin/users/${u.id}/unfreeze`);
      notify("success", t("admin.users.unfreezeDone"));
      await load();
    } catch (e: any) {
      notify("error", "解冻失败", e?.message);
    } finally {
      setActioning(null);
    }
  };

  const onKick = async (u: UserRow) => {
    if (
      !(await confirm({
        title: t("admin.users.kickTitle", { name: u.username }),
        description: t("admin.users.kickDesc"),
        level: "danger",
      }))
    )
      return;
    setActioning({ id: u.id, action: "kick" });
    try {
      await apiPost(`/api/admin/users/${u.id}/kick`);
      notify("success", t("admin.users.kickDone"));
    } catch (e: any) {
      notify("error", "踢出失败", e?.message);
    } finally {
      setActioning(null);
    }
  };

  const onReset = async (u: UserRow) => {
    const r = await prompt({
      title: t("admin.users.resetTitle", { name: u.username }),
      description: t("admin.users.resetDesc"),
      danger: true,
      fields: [
        {
          name: "pw",
          label: t("admin.users.resetPrompt"),
          placeholder: t("admin.users.resetPrompt.ph"),
          type: "password",
          required: true,
          validate: (v) =>
            v.length < 6 ? t("admin.users.resetShort") : null,
        },
      ],
    });
    if (!r) return;
    setActioning({ id: u.id, action: "reset" });
    try {
      await apiPost(`/api/admin/users/${u.id}/reset-password`, {
        newPassword: r.pw,
      });
      notify("success", t("admin.users.resetDone"));
    } catch (e: any) {
      notify("error", "重置失败", e?.message);
    } finally {
      setActioning(null);
    }
  };

  const onDelete = async (u: UserRow) => {
    if (
      !(await confirm({
        title: t("admin.users.delTitle", { name: u.username }),
        description: t("admin.users.delDesc"),
        level: "critical",
        confirmText: u.username,
      }))
    )
      return;
    setActioning({ id: u.id, action: "delete" });
    try {
      await apiDelete(`/api/admin/users/${u.id}`);
      notify("success", t("admin.users.delDone"));
      await load();
    } catch (e: any) {
      notify("error", "删除失败", e?.message);
    } finally {
      setActioning(null);
    }
  };

  return (
    <div ref={ref} className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border/60 px-6 py-4">
        <label className="relative flex h-10 min-w-[220px] flex-1 items-center sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 h-4 w-4 text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("admin.users.search")}
            className="no-drag h-10 w-full rounded-xl border border-border bg-surface-2 pl-9 pr-3 text-sm focus:border-primary/60 focus:shadow-[0_0_0_3px_rgb(var(--primary)/0.18)] focus:outline-none"
          />
        </label>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void load()}
          loading={loading}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {t("admin.users.refresh")}
        </Button>
        <Button size="sm" onClick={() => setCreating(true)} className="ml-auto">
          <Plus className="h-4 w-4" />
          {t("admin.users.create")}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <div className="overflow-hidden rounded-2xl border border-border bg-surface/40">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-xs text-muted">
              <tr>
                <th className="px-3 py-2.5 text-left">ID</th>
                <th className="px-3 py-2.5 text-left">{t("admin.users.col.username")}</th>
                <th className="px-3 py-2.5 text-left">{t("admin.users.col.role")}</th>
                <th className="px-3 py-2.5 text-left">{t("admin.users.col.status")}</th>
                <th className="px-3 py-2.5 text-left">{t("admin.users.col.invite")}</th>
                <th className="px-3 py-2.5 text-left">{t("admin.users.col.lastLogin")}</th>
                <th className="px-3 py-2.5 text-right">{t("admin.users.col.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t border-border/40">
                  <td className="px-3 py-2.5 text-muted">{u.id}</td>
                  <td className="px-3 py-2.5 font-medium">{u.username}</td>
                  <td className="px-3 py-2.5 text-muted">{u.roleName}</td>
                  <td className="px-3 py-2.5">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs",
                        STATUS_TONE[u.status],
                      )}
                    >
                      {u.status}
                    </span>
                    {u.statusReason && (
                      <p className="mt-1 truncate text-[10px] text-muted">
                        {u.statusReason}
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-xs text-muted">
                    {u.inviteCode ?? "—"}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted">
                    {u.lastLoginAt ? new Date(u.lastLoginAt + "Z").toLocaleString() : "—"}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex justify-end gap-1.5">
                      <IconBtn
                        title={t("admin.users.act.edit")}
                        onClick={() => setEditing(u)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </IconBtn>
                      {u.status === "banned" ? (
                        <IconBtn
                          tone="success"
                          title={t("admin.users.act.unban")}
                          onClick={() => void onUnban(u)}
                          loading={
                            actioning?.id === u.id && actioning.action === "unban"
                          }
                        >
                          <Check className="h-3.5 w-3.5" />
                        </IconBtn>
                      ) : (
                        <IconBtn
                          tone="danger"
                          title={t("admin.users.act.ban")}
                          onClick={() => void onBan(u)}
                          loading={
                            actioning?.id === u.id && actioning.action === "ban"
                          }
                        >
                          <Ban className="h-3.5 w-3.5" />
                        </IconBtn>
                      )}
                      {u.status === "frozen" ? (
                        <IconBtn
                          tone="success"
                          title={t("admin.users.act.unfreeze")}
                          onClick={() => void onUnfreeze(u)}
                        >
                          <Check className="h-3.5 w-3.5" />
                        </IconBtn>
                      ) : (
                        <IconBtn
                          tone="info"
                          title={t("admin.users.act.freeze")}
                          onClick={() => void onFreeze(u)}
                          loading={
                            actioning?.id === u.id && actioning.action === "freeze"
                          }
                        >
                          <Snowflake className="h-3.5 w-3.5" />
                        </IconBtn>
                      )}
                      <IconBtn
                        title={t("admin.users.act.kick")}
                        onClick={() => void onKick(u)}
                        loading={
                          actioning?.id === u.id && actioning.action === "kick"
                        }
                      >
                        <LogOut className="h-3.5 w-3.5" />
                      </IconBtn>
                      <IconBtn
                        title={t("admin.users.act.reset")}
                        onClick={() => void onReset(u)}
                        loading={
                          actioning?.id === u.id && actioning.action === "reset"
                        }
                      >
                        <KeyRound className="h-3.5 w-3.5" />
                      </IconBtn>
                      <IconBtn
                        tone="danger"
                        title={t("admin.users.act.delete")}
                        onClick={() => void onDelete(u)}
                        loading={
                          actioning?.id === u.id && actioning.action === "delete"
                        }
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </IconBtn>
                    </div>
                  </td>
                </tr>
              ))}
              {users.length === 0 && !loading && (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-xs text-muted">
                    {t("admin.users.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <UserFormModal
        open={creating}
        onClose={() => setCreating(false)}
        roles={roles}
        onSaved={() => {
          setCreating(false);
          void load();
        }}
      />
      <UserFormModal
        open={!!editing}
        onClose={() => setEditing(null)}
        editing={editing}
        roles={roles}
        onSaved={() => {
          setEditing(null);
          void load();
        }}
      />
    </div>
  );
}

function IconBtn({
  children,
  title,
  tone,
  loading,
  onClick,
}: {
  children: React.ReactNode;
  title: string;
  tone?: "danger" | "info" | "success";
  loading?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={loading}
      className={cn(
        "no-drag grid h-7 w-7 place-items-center rounded-lg border border-border/60 bg-surface/40 transition-colors",
        "hover:border-primary/40 hover:text-text disabled:opacity-50",
        tone === "danger" && "hover:border-danger/60 hover:text-danger",
        tone === "info" && "hover:border-info/60 hover:text-info",
        tone === "success" && "hover:border-success/60 hover:text-success",
      )}
    >
      {children}
    </button>
  );
}

function UserFormModal({
  open,
  onClose,
  editing,
  roles,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  editing?: UserRow | null;
  roles: RoleRef[];
  onSaved: () => void;
}) {
  const t = useT();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState<number>(2);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editing) {
      setUsername(editing.username);
      setEmail(editing.email ?? "");
      setRoleId(editing.roleId);
      setPassword("");
    } else if (open) {
      setUsername("");
      setEmail("");
      setRoleId(2);
      setPassword("");
    }
  }, [editing, open]);

  const submit = async () => {
    setSaving(true);
    try {
      if (editing) {
        await apiPatch(`/api/admin/users/${editing.id}`, {
          email: email || null,
          roleId,
        });
      } else {
        if (!username || password.length < 6) {
          notify("error", t("admin.users.formInvalid"));
          setSaving(false);
          return;
        }
        await apiPost("/api/admin/users", {
          username,
          password,
          roleId,
          email: email || null,
        });
      }
      notify("success", t("admin.users.saved"));
      onSaved();
    } catch (e: any) {
      notify("error", t("admin.users.saveFail"), e?.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? t("admin.users.edit") : t("admin.users.create")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void submit()} loading={saving}>
            {editing ? t("common.save") : t("common.create")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <TextField
          label={t("admin.users.col.username")}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          disabled={!!editing}
          required
        />
        {!editing && (
          <TextField
            label={t("admin.users.initialPassword")}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            hint={t("admin.users.pwHint")}
            required
          />
        )}
        <TextField
          label="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Select
          label={t("admin.users.col.role")}
          value={String(roleId)}
          onValueChange={(v) => setRoleId(Number(v))}
          options={roles.map((r) => ({ value: String(r.id), label: r.name }))}
        />
      </div>
    </Modal>
  );
}

// reuse unused icon to silence linter
void UserPlus;

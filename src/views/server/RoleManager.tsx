import { useCallback, useEffect, useState } from "react";
import { Plus, Save, ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { TextField } from "@/components/ui/TextField";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { cn } from "@/lib/cn";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/services/apiClient";
import { notify } from "@/services/notify";
import { confirm } from "@/store/useConfirmStore";

interface Role {
  id: number;
  name: string;
  description: string | null;
  isSystem: number;
  permissions: string[];
}

interface PermissionRow {
  key: string;
  description: string;
  group: string;
}

const GROUP_TITLE: Record<string, string> = {
  self: "自助",
  user: "用户管理",
  role: "角色管理",
  code: "激活码",
  tier: "订阅档位",
  usage: "用量监控",
  config: "服务端配置",
  invite: "邀请",
};

export function RoleManager() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 12 });

  const [roles, setRoles] = useState<Role[]>([]);
  const [perms, setPerms] = useState<PermissionRow[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Role | null>(null);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([
        apiGet<{ roles: Role[] }>("/api/admin/roles"),
        apiGet<{ permissions: PermissionRow[] }>("/api/admin/permissions"),
      ]);
      setRoles(a.roles);
      setPerms(b.permissions);
      if (a.roles.length && selectedId === null) {
        setSelectedId(a.roles[0].id);
      }
    } catch (e: any) {
      notify("error", "加载失败", e?.message);
    }
  }, [selectedId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const cur = roles.find((r) => r.id === selectedId) ?? null;
    setDraft(cur ? { ...cur, permissions: [...cur.permissions] } : null);
  }, [selectedId, roles]);

  const groups = perms.reduce<Record<string, PermissionRow[]>>((acc, p) => {
    (acc[p.group] ||= []).push(p);
    return acc;
  }, {});

  const toggle = (key: string) => {
    if (!draft) return;
    if (draft.permissions.includes("*")) {
      // 通配权限：不允许细分
      return;
    }
    const next = draft.permissions.includes(key)
      ? draft.permissions.filter((p) => p !== key)
      : [...draft.permissions, key];
    setDraft({ ...draft, permissions: next });
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await apiPatch(`/api/admin/roles/${draft.id}`, {
        name: draft.name,
        description: draft.description,
        permissions: draft.permissions,
      });
      notify("success", t("admin.roles.saved"));
      await load();
    } catch (e: any) {
      notify("error", "保存失败", e?.message);
    } finally {
      setSaving(false);
    }
  };

  const del = async (r: Role) => {
    if (
      !(await confirm({
        title: t("admin.roles.delTitle", { name: r.name }),
        level: "critical",
        confirmText: r.name,
      }))
    )
      return;
    try {
      await apiDelete(`/api/admin/roles/${r.id}`);
      notify("success", t("admin.roles.delDone"));
      setSelectedId(null);
      await load();
    } catch (e: any) {
      notify("error", "删除失败", e?.message);
    }
  };

  return (
    <div ref={ref} className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border/60 px-6 py-4">
        <h1 className="text-sm font-semibold">{t("admin.roles.title")}</h1>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" />
          {t("admin.roles.create")}
        </Button>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-12 gap-4 p-6">
        <aside className="col-span-3 space-y-1 overflow-y-auto rounded-2xl border border-border bg-surface/40 p-2">
          {roles.map((r) => (
            <button
              key={r.id}
              onClick={() => setSelectedId(r.id)}
              className={cn(
                "flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm",
                selectedId === r.id
                  ? "bg-primary/10 text-primary"
                  : "text-muted hover:bg-surface-2 hover:text-text",
              )}
            >
              <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
              <span className="flex-1 truncate">{r.name}</span>
              {r.isSystem !== 0 && (
                <span className="rounded-full bg-surface-2 px-1.5 text-[10px] text-muted/70">
                  {t("admin.roles.systemTag")}
                </span>
              )}
            </button>
          ))}
        </aside>

        <section className="col-span-9 flex min-h-0 flex-col gap-4 overflow-y-auto rounded-2xl border border-border bg-surface/40 p-5">
          {draft ? (
            <>
              <div className="flex items-center gap-3">
                <div className="flex-1 space-y-3">
                  <TextField
                    label={t("admin.roles.name")}
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    disabled={draft.isSystem !== 0}
                  />
                  <TextField
                    label={t("admin.roles.desc")}
                    value={draft.description ?? ""}
                    onChange={(e) =>
                      setDraft({ ...draft, description: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Button onClick={() => void save()} loading={saving}>
                    <Save className="h-4 w-4" />
                    {t("common.save")}
                  </Button>
                  {draft.isSystem === 0 && (
                    <Button
                      variant="ghost"
                      onClick={() => void del(draft)}
                      className="text-danger hover:text-danger"
                    >
                      <Trash2 className="h-4 w-4" />
                      {t("common.delete")}
                    </Button>
                  )}
                </div>
              </div>

              {draft.permissions.includes("*") && (
                <p className="rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-primary">
                  {t("admin.roles.wildcardHint")}
                </p>
              )}

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                {Object.entries(groups).map(([g, items]) => (
                  <div
                    key={g}
                    className="rounded-xl border border-border bg-surface-2/40 p-3"
                  >
                    <p className="mb-2 text-xs font-semibold text-muted/80">
                      {GROUP_TITLE[g] ?? g}
                    </p>
                    <div className="space-y-1.5">
                      {items.map((p) => {
                        const enabled =
                          draft.permissions.includes("*") ||
                          draft.permissions.includes(p.key);
                        return (
                          <label
                            key={p.key}
                            className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1 text-xs hover:bg-surface/60"
                          >
                            <input
                              type="checkbox"
                              checked={enabled}
                              onChange={() => toggle(p.key)}
                              disabled={draft.permissions.includes("*")}
                              className="mt-0.5 h-3.5 w-3.5 rounded accent-primary"
                            />
                            <div className="min-w-0 flex-1">
                              <p className="font-mono text-[11px]">{p.key}</p>
                              <p className="text-[10px] text-muted">
                                {p.description}
                              </p>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="grid h-full place-items-center text-xs text-muted">
              {t("admin.roles.pickHint")}
            </div>
          )}
        </section>
      </div>

      <CreateRoleModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          void load();
        }}
      />
    </div>
  );
}

function CreateRoleModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName("");
      setDesc("");
    }
  }, [open]);

  const submit = async () => {
    setSaving(true);
    try {
      await apiPost("/api/admin/roles", {
        name,
        description: desc,
        permissions: ["self.read", "self.update", "self.password"],
      });
      notify("success", t("admin.roles.created"));
      onCreated();
    } catch (e: any) {
      notify("error", "创建失败", e?.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("admin.roles.createTitle")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void submit()} loading={saving} disabled={!name}>
            {t("common.create")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <TextField
          label={t("admin.roles.name")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          required
        />
        <TextField
          label={t("admin.roles.desc")}
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
        />
        <p className="text-xs text-muted">{t("admin.roles.afterCreateHint")}</p>
      </div>
    </Modal>
  );
}

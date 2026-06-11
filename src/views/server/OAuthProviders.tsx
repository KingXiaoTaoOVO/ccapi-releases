import { useCallback, useEffect, useState } from "react";
import { Link2, Pencil, Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { TextField } from "@/components/ui/TextField";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/services/apiClient";
import { notify } from "@/services/notify";
import { confirm } from "@/store/useConfirmStore";

interface Provider {
  id: number;
  code: string;
  displayName: string;
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scopes: string;
  enabled: number;
}

interface Form {
  code: string;
  displayName: string;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scopes: string;
  enabled: boolean;
}

const EMPTY: Form = {
  code: "",
  displayName: "",
  clientId: "",
  clientSecret: "",
  authorizeUrl: "",
  tokenUrl: "",
  userinfoUrl: "",
  scopes: "",
  enabled: true,
};

const PRESETS: { name: string; form: Partial<Form> }[] = [
  {
    name: "GitHub",
    form: {
      code: "github",
      displayName: "GitHub",
      authorizeUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      userinfoUrl: "https://api.github.com/user",
      scopes: "read:user user:email",
    },
  },
  {
    name: "Discord",
    form: {
      code: "discord",
      displayName: "Discord",
      authorizeUrl: "https://discord.com/api/oauth2/authorize",
      tokenUrl: "https://discord.com/api/oauth2/token",
      userinfoUrl: "https://discord.com/api/users/@me",
      scopes: "identify email",
    },
  },
  {
    name: "LinuxDo",
    form: {
      code: "linuxdo",
      displayName: "LinuxDo",
      authorizeUrl: "https://connect.linux.do/oauth2/authorize",
      tokenUrl: "https://connect.linux.do/oauth2/token",
      userinfoUrl: "https://connect.linux.do/api/user",
      scopes: "",
    },
  },
  {
    name: "Google (OIDC)",
    form: {
      code: "google",
      displayName: "Google",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
      scopes: "openid email profile",
    },
  },
  {
    name: "GitLab",
    form: {
      code: "gitlab",
      displayName: "GitLab",
      authorizeUrl: "https://gitlab.com/oauth/authorize",
      tokenUrl: "https://gitlab.com/oauth/token",
      userinfoUrl: "https://gitlab.com/oauth/userinfo",
      scopes: "openid read_user email",
    },
  },
  {
    name: "Microsoft (OIDC)",
    form: {
      code: "microsoft",
      displayName: "Microsoft",
      authorizeUrl:
        "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      userinfoUrl: "https://graph.microsoft.com/oidc/userinfo",
      scopes: "openid email profile",
    },
  },
  {
    name: "Custom (OIDC discover)",
    form: { code: "", displayName: "" },
  },
];

export function OAuthProviders() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 12 });
  const [list, setList] = useState<Provider[]>([]);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<Form>(EMPTY);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await apiGet<{ providers: Provider[] }>(
        "/api/admin/oauth/providers",
      );
      setList(r.providers);
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
  const openEdit = (p: Provider) => {
    setForm({
      code: p.code,
      displayName: p.displayName,
      clientId: p.clientId,
      clientSecret: "",
      authorizeUrl: p.authorizeUrl,
      tokenUrl: p.tokenUrl,
      userinfoUrl: p.userinfoUrl,
      scopes: p.scopes,
      enabled: !!p.enabled,
    });
    setEditing(p);
  };
  const close = () => {
    setCreating(false);
    setEditing(null);
  };

  const submit = async () => {
    if (!form.code.trim() || !form.displayName.trim() || !form.clientId.trim()) {
      notify("error", t("oauth.err.required"));
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await apiPatch(`/api/admin/oauth/providers/${editing.id}`, form);
      } else {
        if (!form.clientSecret) {
          notify("error", t("oauth.err.secretRequired"));
          setSaving(false);
          return;
        }
        await apiPost("/api/admin/oauth/providers", form);
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

  const discoverOidc = async () => {
    const issuer = window.prompt(
      t("oauth.discover.prompt"),
      "https://example.com",
    );
    if (!issuer) return;
    const url = issuer.replace(/\/+$/, "") + "/.well-known/openid-configuration";
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const cfg: {
        authorization_endpoint: string;
        token_endpoint: string;
        userinfo_endpoint: string;
        issuer: string;
      } = await resp.json();
      setForm((s) => ({
        ...s,
        authorizeUrl: cfg.authorization_endpoint,
        tokenUrl: cfg.token_endpoint,
        userinfoUrl: cfg.userinfo_endpoint,
        scopes: s.scopes || "openid email profile",
      }));
      notify("success", t("oauth.discover.ok"));
    } catch (e: any) {
      notify("error", t("oauth.discover.fail"), e?.message);
    }
  };

  const remove = async (p: Provider) => {
    const ok = await confirm({
      title: t("oauth.del.title", { name: p.displayName }),
      level: "danger",
    });
    if (!ok) return;
    try {
      await apiDelete(`/api/admin/oauth/providers/${p.id}`);
      await load();
    } catch (e: any) {
      notify("error", t("common.delFail"), e?.message);
    }
  };

  return (
    <div ref={ref} className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="flex items-end justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <Link2 className="h-5 w-5 text-primary" />
              {t("oauth.title")}
            </h1>
            <p className="mt-1 text-sm text-muted">{t("oauth.subtitle")}</p>
          </div>
          <Button onClick={openCreate}>
            <Plus className="h-3.5 w-3.5" />
            {t("oauth.create")}
          </Button>
        </header>

        {list.length === 0 ? (
          <div className="grid place-items-center rounded-2xl border border-dashed border-border bg-surface/40 py-16 text-sm text-muted">
            {t("oauth.empty")}
          </div>
        ) : (
          <div className="space-y-2">
            {list.map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-3 rounded-2xl border border-border bg-surface/60 p-4 backdrop-blur-xl"
              >
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10">
                  <Link2 className="h-5 w-5 text-primary" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{p.displayName}</p>
                  <p className="text-xs text-muted">code: {p.code}</p>
                </div>
                <span
                  className={
                    "rounded-full px-2 py-0.5 text-[10px] " +
                    (p.enabled
                      ? "bg-success/15 text-success"
                      : "bg-muted/15 text-muted")
                  }
                >
                  {p.enabled ? t("common.enabled") : t("common.disabled")}
                </span>
                <Button size="sm" variant="ghost" onClick={() => openEdit(p)}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void remove(p)}
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
        onClose={close}
        title={editing ? t("oauth.edit", { name: editing.displayName }) : t("oauth.create")}
        size="lg"
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
          {!editing && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                <span className="text-xs text-muted">{t("oauth.preset")}：</span>
                {PRESETS.map((p) => (
                  <button
                    key={p.name}
                    onClick={() => setForm((s) => ({ ...s, ...p.form }))}
                    className="rounded-full border border-border px-3 py-1 text-xs hover:border-primary/40"
                  >
                    {p.name}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => void discoverOidc()}
                className="text-[11px] text-primary hover:underline"
              >
                {t("oauth.discover.btn")}
              </button>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <TextField
              label={t("oauth.code")}
              value={form.code}
              onChange={(e) => setForm((s) => ({ ...s, code: e.target.value }))}
              placeholder="github"
              disabled={!!editing}
            />
            <TextField
              label={t("oauth.displayName")}
              value={form.displayName}
              onChange={(e) =>
                setForm((s) => ({ ...s, displayName: e.target.value }))
              }
              placeholder="GitHub"
            />
          </div>
          <TextField
            label="client_id"
            value={form.clientId}
            onChange={(e) => setForm((s) => ({ ...s, clientId: e.target.value }))}
          />
          <TextField
            label="client_secret"
            type="password"
            value={form.clientSecret}
            onChange={(e) =>
              setForm((s) => ({ ...s, clientSecret: e.target.value }))
            }
            placeholder={editing ? t("oauth.secret.editPh") : ""}
          />
          <TextField
            label="authorize_url"
            value={form.authorizeUrl}
            onChange={(e) =>
              setForm((s) => ({ ...s, authorizeUrl: e.target.value }))
            }
          />
          <TextField
            label="token_url"
            value={form.tokenUrl}
            onChange={(e) =>
              setForm((s) => ({ ...s, tokenUrl: e.target.value }))
            }
          />
          <TextField
            label="userinfo_url"
            value={form.userinfoUrl}
            onChange={(e) =>
              setForm((s) => ({ ...s, userinfoUrl: e.target.value }))
            }
          />
          <TextField
            label="scopes"
            value={form.scopes}
            onChange={(e) => setForm((s) => ({ ...s, scopes: e.target.value }))}
            placeholder="read:user user:email"
          />
          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2 py-2">
            <span className="text-sm">{t("common.enabled")}</span>
            <Switch
              checked={form.enabled}
              onChange={(v) => setForm((s) => ({ ...s, enabled: v }))}
            />
          </label>
        </div>
      </Modal>
    </div>
  );
}

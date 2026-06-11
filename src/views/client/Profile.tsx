import { useState } from "react";
import { AtSign, Camera, Download, FileJson, KeyRound, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { Avatar } from "@/components/Avatar/Avatar";
import { AvatarUploadModal } from "@/components/Avatar/AvatarUploadModal";
import { ClaudeCodePanel } from "@/components/ClaudeCodePanel/ClaudeCodePanel";
import { PreferencesPanel } from "@/components/PreferencesPanel/PreferencesPanel";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { useAuthStore } from "@/store/useAuthStore";
import { deleteUserAvatar } from "@/services/tauri";
import { apiPost } from "@/services/apiClient";
import { downloadAdminExport } from "@/services/exportDownload";
import { confirm } from "@/store/useConfirmStore";
import { prompt } from "@/store/usePromptStore";
import { notify } from "@/services/notify";

export function Profile() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 12 });
  const user = useAuthStore((s) => s.session?.user);
  const changePassword = useAuthStore((s) => s.changePassword);

  const [oldPw, setOldPw] = useState("");
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [saving, setSaving] = useState(false);
  const [showAvatar, setShowAvatar] = useState(false);
  const [avatarBust, setAvatarBust] = useState(0);
  const [exporting, setExporting] = useState<"usage" | "account" | null>(null);

  const doExport = async (kind: "usage" | "account") => {
    setExporting(kind);
    try {
      const path =
        kind === "usage"
          ? "/api/me/export/usage.csv"
          : "/api/me/export/account.json";
      const file = kind === "usage" ? "usage.csv" : "account.json";
      const saved = await downloadAdminExport(path, file);
      if (saved === null) {
        notify("info", t("profile.export.cancelled"));
      } else {
        notify(
          "success",
          t("profile.export.ok"),
          t("profile.export.ok.desc", { file: saved }),
        );
      }
    } catch (e: any) {
      notify("error", t("common.exportFail"), e?.message ?? String(e));
    } finally {
      setExporting(null);
    }
  };

  const onChangeUsername = async () => {
    const r = await prompt({
      title: t("profile.changeUsername"),
      description: t("profile.changeUsername.desc"),
      fields: [
        {
          name: "newUsername",
          label: t("profile.newUsername"),
          required: true,
          defaultValue: user?.username ?? "",
          validate: (v) =>
            /^[A-Za-z0-9_-]{3,32}$/.test(v) ? null : t("profile.username.invalid"),
        },
        {
          name: "password",
          label: t("auth.cp.old"),
          type: "password",
          required: true,
        },
      ],
    });
    if (!r) return;
    try {
      await apiPost("/api/me/change-username", {
        newUsername: r.newUsername,
        password: r.password,
      });
      notify("success", t("profile.username.updated"));
      window.location.reload();
    } catch (e: any) {
      notify("error", t("common.saveFail"), e?.message);
    }
  };

  const onChangeEmail = async () => {
    const r = await prompt({
      title: t("profile.changeEmail"),
      description: t("profile.changeEmail.desc"),
      fields: [
        {
          name: "newEmail",
          label: t("profile.newEmail"),
          required: true,
          defaultValue: user?.email ?? "",
          validate: (v) => (v.includes("@") ? null : t("auth.reg.email.invalid")),
        },
        {
          name: "password",
          label: t("auth.cp.old"),
          type: "password",
          required: true,
        },
        {
          name: "emailCode",
          label: t("auth.reg.emailCode"),
          required: true,
          hint: t("profile.email.codeHint"),
        },
      ],
    });
    if (!r) return;
    try {
      await apiPost("/api/me/change-email", {
        newEmail: r.newEmail,
        password: r.password,
        emailCode: r.emailCode,
      });
      notify("success", t("profile.email.updated"));
      window.location.reload();
    } catch (e: any) {
      notify("error", t("common.saveFail"), e?.message);
    }
  };

  const onSendEmailCode = async () => {
    const email = window.prompt(t("profile.email.targetPrompt"), user?.email ?? "");
    if (!email || !email.includes("@")) return;
    try {
      await apiPost(
        "/api/email-code/send",
        { email, purpose: "bind_email" },
        { auth: false },
      );
      notify("success", t("auth.reg.code.sent"));
    } catch (e: any) {
      notify("error", t("common.saveFail"), e?.message);
    }
  };

  const onRemoveAvatar = async () => {
    if (!user) return;
    const ok = await confirm({
      title: t("avatar.removeTitle"),
      description: t("avatar.removeDesc"),
      level: "danger",
    });
    if (!ok) return;
    try {
      await deleteUserAvatar(user.id);
      setAvatarBust((x) => x + 1);
      notify("success", t("avatar.removed"));
    } catch (e: any) {
      notify("error", t("avatar.saveFail"), e?.message);
    }
  };

  const submit = async () => {
    if (!oldPw || !pw1 || pw1 !== pw2 || pw1.length < 6) {
      notify("error", t("auth.cp.mismatch"));
      return;
    }
    setSaving(true);
    try {
      await changePassword(oldPw, pw1);
      notify("success", t("auth.cp.okTitle"));
      setOldPw("");
      setPw1("");
      setPw2("");
    } catch (e: any) {
      notify("error", "修改失败", e?.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div ref={ref} className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-2xl space-y-6">
        <header>
          <h1 className="text-xl font-semibold">{t("client.profile.title")}</h1>
          <p className="mt-1 text-sm text-muted">{t("client.profile.subtitle")}</p>
        </header>

        <section className="rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
          <div className="flex flex-wrap items-center gap-4">
            <Avatar
              userId={user?.id ?? null}
              username={user?.username}
              size="lg"
              bust={avatarBust}
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">
                {user?.username}
                <button
                  className="ml-2 inline-flex h-5 w-5 items-center justify-center rounded text-muted hover:text-text"
                  onClick={() => void onChangeUsername()}
                  title={t("profile.changeUsername")}
                >
                  <Pencil className="h-3 w-3" />
                </button>
              </p>
              <p className="text-xs text-muted">{user?.role}</p>
              <p className="mt-0.5 flex items-center gap-1 text-xs text-muted">
                {user?.email || t("profile.noEmail")}
                <button
                  className="inline-flex h-4 w-4 items-center justify-center rounded text-muted hover:text-text"
                  onClick={() => void onChangeEmail()}
                  title={t("profile.changeEmail")}
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  className="inline-flex h-4 items-center gap-0.5 rounded px-1 text-[10px] text-primary/80 hover:text-primary"
                  onClick={() => void onSendEmailCode()}
                  title={t("auth.reg.code.send")}
                >
                  <AtSign className="h-2.5 w-2.5" />
                  {t("auth.reg.code.send")}
                </button>
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowAvatar(true)}
                disabled={!user}
              >
                <Camera className="h-3.5 w-3.5" />
                {t("avatar.change")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void onRemoveAvatar()}
                disabled={!user}
                className="text-danger hover:bg-danger/10"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t("avatar.remove")}
              </Button>
            </div>
          </div>
        </section>

        {user && (
          <AvatarUploadModal
            open={showAvatar}
            userId={user.id}
            onClose={() => setShowAvatar(false)}
            onSaved={() => setAvatarBust((x) => x + 1)}
          />
        )}

        <ClaudeCodePanel />

        <PreferencesPanel />

        <section className="rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
          <div className="mb-3 flex items-center gap-2">
            <Download className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold">{t("profile.export.title")}</h2>
          </div>
          <p className="mb-3 text-xs text-muted">{t("profile.export.desc")}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="ghost"
              loading={exporting === "usage"}
              onClick={() => void doExport("usage")}
            >
              <Download className="h-3.5 w-3.5" />
              {t("profile.export.usage")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              loading={exporting === "account"}
              onClick={() => void doExport("account")}
            >
              <FileJson className="h-3.5 w-3.5" />
              {t("profile.export.account")}
            </Button>
          </div>
        </section>

        <section className="rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
          <div className="mb-4 flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-warning" />
            <h2 className="text-sm font-semibold">{t("client.profile.changePw")}</h2>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            className="space-y-3"
          >
            <TextField
              label={t("auth.cp.old")}
              type="password"
              value={oldPw}
              onChange={(e) => setOldPw(e.target.value)}
              placeholder={t("form.cp.old.ph")}
              autoComplete="current-password"
              required
            />
            <TextField
              label={t("auth.cp.new")}
              type="password"
              value={pw1}
              onChange={(e) => setPw1(e.target.value)}
              placeholder={t("form.cp.new.ph")}
              hint={t("auth.cp.rule")}
              autoComplete="new-password"
              required
            />
            <TextField
              label={t("auth.cp.confirm")}
              type="password"
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
              placeholder={t("form.cp.confirm.ph")}
              autoComplete="new-password"
              required
            />
            <Button type="submit" loading={saving}>
              {t("auth.cp.submit")}
            </Button>
          </form>
        </section>
      </div>
    </div>
  );
}

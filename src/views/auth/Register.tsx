import { useEffect, useState } from "react";
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Captcha } from "@/components/Captcha";
import { TextField } from "@/components/ui/TextField";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { apiPost } from "@/services/apiClient";
import { notify } from "@/services/notify";
import { useAuthStore } from "@/store/useAuthStore";
import { useServerInfoStore } from "@/store/useServerInfoStore";
import type { TokenPair, UserBrief } from "@/types/auth";

interface RegisterPolicyView {
  open: boolean;
  requireInviteCode: boolean;
  requireEmailVerify: boolean;
  captchaStrength: "off" | "easy" | "normal" | "strong";
}

interface Props {
  onSwitchToLogin: () => void;
}

export function Register({ onSwitchToLogin }: Props) {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 16 });
  const setSession = useAuthStore((s) => s.set);
  const serverInfo = useServerInfoStore((s) => s.info);
  const policy = (serverInfo?.registerPolicy ?? {
    open: true,
    requireInviteCode: false,
    requireEmailVerify: false,
    captchaStrength: "normal",
  }) as RegisterPolicyView;

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [email, setEmail] = useState("");
  const [invite, setInvite] = useState("");
  const [captchaId, setCaptchaId] = useState("");
  const [captchaAnswer, setCaptchaAnswer] = useState("");
  const [captchaReloadKey, setCaptchaReloadKey] = useState(0);
  const [emailCode, setEmailCode] = useState("");
  const [sendingCode, setSendingCode] = useState(false);
  const [codeCooldown, setCodeCooldown] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (codeCooldown <= 0) return;
    const id = window.setInterval(
      () => setCodeCooldown((c) => Math.max(0, c - 1)),
      1000,
    );
    return () => window.clearInterval(id);
  }, [codeCooldown]);

  const sendEmailCode = async () => {
    if (!email || !email.includes("@")) {
      setErr(t("auth.reg.email.invalid"));
      return;
    }
    setSendingCode(true);
    setErr(null);
    try {
      await apiPost(
        "/api/email-code/send",
        { email, purpose: "register" },
        { auth: false },
      );
      notify("success", t("auth.reg.code.sent"));
      setCodeCooldown(60);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setSendingCode(false);
    }
  };

  const submit = async () => {
    if (!username || !password) {
      setErr(t("auth.reg.empty"));
      return;
    }
    if (password.length < 6) {
      setErr(t("auth.reg.pwShort"));
      return;
    }
    if (password !== confirm) {
      setErr(t("auth.cp.mismatch"));
      return;
    }
    if (!captchaAnswer) {
      setErr(t("captcha.required"));
      return;
    }
    if (!email.trim() || !email.includes("@")) {
      setErr(t("auth.reg.email.invalid"));
      return;
    }
    if (policy.requireInviteCode && !invite.trim()) {
      setErr(t("auth.reg.inviteRequired"));
      return;
    }
    if (policy.requireEmailVerify && !emailCode.trim()) {
      setErr(t("auth.reg.emailCodeRequired"));
      return;
    }
    setErr(null);
    setLoading(true);
    try {
      const r = await apiPost<{
        tokens: TokenPair;
        user: UserBrief;
        bonusAwarded: number;
      }>(
        "/api/register",
        {
          username,
          password,
          email: email || null,
          inviteCode: invite || null,
          captchaId,
          captchaAnswer,
          emailCode: emailCode || null,
        },
        { auth: false },
      );
      setSession({ tokens: r.tokens, user: r.user, scope: "client" });
      notify(
        "success",
        t("auth.reg.okTitle"),
        t("auth.reg.okDesc", { bonus: r.bonusAwarded.toString() }),
      );
    } catch (e: any) {
      setErr(e?.message ?? String(e));
      // 失败时自动换一张验证码，避免反复撞同一张错验
      setCaptchaReloadKey((k) => k + 1);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      ref={ref}
      className="flex h-full w-full justify-center overflow-y-auto px-6 py-10"
    >
      <div className="my-auto w-full max-w-md space-y-6">
        <header className="space-y-2 text-center">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-border bg-surface shadow-glow">
            <UserPlus className="h-6 w-6 text-primary" />
          </div>
          <h1 className="text-xl font-semibold">{t("auth.reg.title")}</h1>
          <p className="text-sm text-muted">{t("auth.reg.subtitle")}</p>
        </header>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="space-y-4 rounded-2xl border border-border bg-surface/60 p-6 shadow-card backdrop-blur-xl"
        >
          <TextField
            label={t("auth.login.username")}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={t("form.reg.username.ph")}
            hint={t("auth.reg.unameHint")}
            required
            autoFocus
          />
          <TextField
            label={t("auth.login.password")}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t("form.reg.password.ph")}
            required
            hint={t("auth.cp.rule")}
          />
          <TextField
            label={t("auth.cp.confirm")}
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder={t("form.reg.confirm.ph")}
            required
          />
          <TextField
            label={t("auth.reg.email")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            placeholder={t("form.reg.email.ph")}
            required
          />
          {policy.requireEmailVerify && (
            <div className="flex items-end gap-2">
              <TextField
                label={t("auth.reg.emailCode")}
                value={emailCode}
                onChange={(e) =>
                  setEmailCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                }
                placeholder="123456"
                required
                className="flex-1"
              />
              <Button
                variant="ghost"
                onClick={() => void sendEmailCode()}
                disabled={sendingCode || codeCooldown > 0 || !email.includes("@")}
                type="button"
              >
                {codeCooldown > 0
                  ? `${codeCooldown}s`
                  : sendingCode
                  ? "…"
                  : t("auth.reg.code.send")}
              </Button>
            </div>
          )}
          <TextField
            label={t("auth.reg.invite")}
            value={invite}
            onChange={(e) => setInvite(e.target.value.toUpperCase())}
            placeholder={t("form.reg.invite.ph")}
            hint={t("auth.reg.inviteHint")}
            className="font-mono"
          />
          <Captcha
            captchaId={captchaId}
            answer={captchaAnswer}
            onIdChange={setCaptchaId}
            onAnswerChange={setCaptchaAnswer}
            error={err ?? undefined}
            reloadKey={captchaReloadKey}
          />
          <Button type="submit" loading={loading} className="w-full">
            {t("auth.reg.submit")}
          </Button>
          <button
            type="button"
            onClick={onSwitchToLogin}
            className="block w-full text-center text-xs text-muted hover:text-text"
          >
            {t("auth.reg.toLogin")}
          </button>
        </form>
      </div>
    </div>
  );
}

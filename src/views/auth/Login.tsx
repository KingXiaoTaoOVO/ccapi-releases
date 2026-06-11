import { useState } from "react";
import { Eye, EyeOff, LogIn } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Captcha } from "@/components/Captcha";
import { TextField } from "@/components/ui/TextField";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { useAuthStore } from "@/store/useAuthStore";
import { useModeStore } from "@/store/useModeStore";
import { useServerInfoStore } from "@/store/useServerInfoStore";
import { notify } from "@/services/notify";

interface Props {
  scope: "server" | "client";
  onSwitchToRegister?: () => void;
  onForgotPassword?: () => void;
}

export function Login({ scope, onSwitchToRegister, onForgotPassword }: Props) {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 16 });
  const login = useAuthStore((s) => s.login);
  const finish2fa = useAuthStore((s) => s.finish2fa);
  const reset = useModeStore((s) => s.reset);
  const serverInfo = useServerInfoStore((s) => s.info);
  const siteName = serverInfo?.site?.name || "CCAPI";
  const announcement = serverInfo?.site?.announcement || "";
  // 只有服务端配了 SMTP 才显示"忘记密码"和邮件相关入口
  const mailEnabled = serverInfo?.mailEnabled ?? false;

  const [username, setUsername] = useState(scope === "server" ? "admin" : "");
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [captchaId, setCaptchaId] = useState("");
  const [captchaAnswer, setCaptchaAnswer] = useState("");
  const [captchaReloadKey, setCaptchaReloadKey] = useState(0);

  // 2FA 第二步
  const [partialToken, setPartialToken] = useState<string | null>(null);
  const [otp, setOtp] = useState("");

  const submit = async () => {
    if (!username || !password) {
      setErr(t("auth.login.empty"));
      return;
    }
    if (scope === "client" && !captchaAnswer) {
      setErr(t("captcha.required"));
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const r = await login(username, password, {
        scope,
        captchaId: scope === "client" ? captchaId : undefined,
        captchaAnswer: scope === "client" ? captchaAnswer : undefined,
      });
      if (r.kind === "needs2fa") {
        setPartialToken(r.partialToken);
      }
    } catch (e: any) {
      setErr(e?.message ?? String(e));
      notify("error", t("auth.login.failTitle"), e?.message ?? String(e));
      // 自动刷一张新验证码，避免一直撞同一张
      if (scope === "client") {
        setCaptchaReloadKey((k) => k + 1);
      }
    } finally {
      setLoading(false);
    }
  };

  const submit2fa = async () => {
    if (!partialToken || otp.length !== 6) return;
    setLoading(true);
    setErr(null);
    try {
      await finish2fa(partialToken, otp, scope);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
      // 失败：清掉 partial 让用户回到第 1 步
      setPartialToken(null);
      setOtp("");
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
        {announcement && scope === "client" && (
          <div className="rounded-2xl border border-info/30 bg-info/10 px-4 py-3 text-xs text-info">
            {announcement}
          </div>
        )}
        <header className="space-y-2 text-center">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-border bg-surface shadow-glow">
            <LogIn className="h-6 w-6 text-primary" />
          </div>
          <h1 className="text-xl font-semibold">
            {scope === "server"
              ? t("auth.login.adminTitle")
              : `${siteName} · ${t("auth.login.userTitle")}`}
          </h1>
          <p className="text-sm text-muted">
            {scope === "server"
              ? t("auth.login.adminSubtitle")
              : t("auth.login.userSubtitle")}
          </p>
        </header>
        {partialToken && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit2fa();
            }}
            className="space-y-4 rounded-2xl border border-border bg-surface/60 p-6 shadow-card backdrop-blur-xl"
          >
            <p className="text-sm">{t("auth.login.2faStep")}</p>
            <TextField
              label={t("sec.2fa.setup.codeLabel")}
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="123456"
              autoFocus
              required
            />
            <Button
              type="submit"
              loading={loading}
              disabled={otp.length !== 6}
              className="w-full"
            >
              {t("auth.login.2faVerify")}
            </Button>
            <button
              type="button"
              onClick={() => {
                setPartialToken(null);
                setOtp("");
                setErr(null);
              }}
              className="w-full text-xs text-muted hover:text-text"
            >
              {t("auth.login.2faBack")}
            </button>
            {err && <p className="text-xs text-danger">{err}</p>}
          </form>
        )}
        {!partialToken && (
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
            placeholder={
              scope === "server"
                ? t("form.login.adminUsername.ph")
                : t("form.login.username.ph")
            }
            autoComplete="username"
            required
            autoFocus
          />
          <div className="relative">
            <TextField
              label={t("auth.login.password")}
              type={reveal ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("form.login.password.ph")}
              autoComplete="current-password"
              required
              error={err ?? undefined}
            />
            <button
              type="button"
              onClick={() => setReveal((v) => !v)}
              className="absolute right-3 top-[34px] text-muted hover:text-text"
              aria-label="toggle reveal"
            >
              {reveal ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          </div>
          {scope === "client" && (
            <Captcha
              captchaId={captchaId}
              answer={captchaAnswer}
              onIdChange={setCaptchaId}
              onAnswerChange={setCaptchaAnswer}
              reloadKey={captchaReloadKey}
            />
          )}
          <Button type="submit" loading={loading} className="w-full">
            {t("auth.login.submit")}
          </Button>
          <div className="flex items-center justify-between text-xs text-muted">
            <button
              type="button"
              onClick={() => void reset()}
              className="hover:text-text"
            >
              {t("auth.login.switchMode")}
            </button>
            {scope === "client" && onSwitchToRegister ? (
              <button
                type="button"
                onClick={onSwitchToRegister}
                className="text-primary hover:underline"
              >
                {t("auth.login.toRegister")}
              </button>
            ) : (
              <span>{t("auth.login.adminHint")}</span>
            )}
          </div>
          {scope === "client" && onForgotPassword && mailEnabled && (
            <button
              type="button"
              onClick={onForgotPassword}
              className="block w-full text-center text-xs text-muted hover:text-text"
            >
              {t("auth.login.forgot")}
            </button>
          )}
        </form>
        )}
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { ArrowLeft, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { apiPost } from "@/services/apiClient";
import { notify } from "@/services/notify";

interface Props {
  onBack: () => void;
}

export function ForgotPassword({ onBack }: Props) {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 16 });
  const [step, setStep] = useState<"send" | "reset">("send");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = window.setInterval(
      () => setCooldown((c) => Math.max(0, c - 1)),
      1000,
    );
    return () => window.clearInterval(id);
  }, [cooldown]);

  const sendCode = async () => {
    if (!email.includes("@")) {
      setErr(t("auth.forgot.email.invalid"));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await apiPost("/api/forgot-password/send", { email }, { auth: false });
      notify("success", t("auth.forgot.codeSent"));
      setStep("reset");
      setCooldown(60);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (newPw.length < 6) {
      setErr(t("auth.cp.short"));
      return;
    }
    if (newPw !== confirm) {
      setErr(t("auth.cp.mismatch"));
      return;
    }
    if (code.length !== 6) {
      setErr(t("auth.forgot.codeFormat"));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await apiPost(
        "/api/forgot-password/reset",
        { email, code, newPassword: newPw },
        { auth: false },
      );
      notify("success", t("auth.forgot.done"));
      onBack();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
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
            <KeyRound className="h-6 w-6 text-primary" />
          </div>
          <h1 className="text-xl font-semibold">{t("auth.forgot.title")}</h1>
          <p className="text-sm text-muted">
            {step === "send"
              ? t("auth.forgot.sendSubtitle")
              : t("auth.forgot.resetSubtitle")}
          </p>
        </header>

        {step === "send" ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void sendCode();
            }}
            className="space-y-4 rounded-2xl border border-border bg-surface/60 p-6 shadow-card backdrop-blur-xl"
          >
            <TextField
              label={t("auth.forgot.email")}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("auth.forgot.email.ph")}
              autoFocus
              required
              error={err ?? undefined}
            />
            <Button type="submit" loading={busy} className="w-full">
              {t("auth.forgot.sendCode")}
            </Button>
            <button
              type="button"
              onClick={onBack}
              className="flex w-full items-center justify-center gap-1 text-xs text-muted hover:text-text"
            >
              <ArrowLeft className="h-3 w-3" />
              {t("auth.forgot.back")}
            </button>
          </form>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void reset();
            }}
            className="space-y-4 rounded-2xl border border-border bg-surface/60 p-6 shadow-card backdrop-blur-xl"
          >
            <p className="rounded-xl border border-info/30 bg-info/10 px-3 py-2 text-xs text-info">
              {t("auth.forgot.codeSentTo", { email })}
            </p>
            <div className="flex items-end gap-2">
              <TextField
                label={t("auth.reg.emailCode")}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="123456"
                required
                className="flex-1"
              />
              <Button
                type="button"
                variant="ghost"
                onClick={() => void sendCode()}
                disabled={busy || cooldown > 0}
              >
                {cooldown > 0 ? `${cooldown}s` : t("auth.reg.code.send")}
              </Button>
            </div>
            <TextField
              label={t("auth.cp.new")}
              type="password"
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              placeholder={t("form.cp.new.ph")}
              required
              hint={t("auth.cp.rule")}
            />
            <TextField
              label={t("auth.cp.confirm")}
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={t("form.cp.confirm.ph")}
              required
              error={err ?? undefined}
            />
            <Button type="submit" loading={busy} className="w-full">
              {t("auth.forgot.submit")}
            </Button>
            <button
              type="button"
              onClick={() => {
                setStep("send");
                setErr(null);
              }}
              className="flex w-full items-center justify-center gap-1 text-xs text-muted hover:text-text"
            >
              <ArrowLeft className="h-3 w-3" />
              {t("auth.forgot.changeEmail")}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

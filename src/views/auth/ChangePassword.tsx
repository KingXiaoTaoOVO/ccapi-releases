import { useState } from "react";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { useAuthStore } from "@/store/useAuthStore";
import { notify } from "@/services/notify";

export function ChangePassword() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 16 });
  const change = useAuthStore((s) => s.changePassword);
  const logout = useAuthStore((s) => s.logout);
  const [oldPw, setOldPw] = useState("");
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!oldPw || !pw1 || !pw2) {
      setErr(t("auth.cp.empty"));
      return;
    }
    if (pw1 !== pw2) {
      setErr(t("auth.cp.mismatch"));
      return;
    }
    if (pw1.length < 6) {
      setErr(t("auth.cp.short"));
      return;
    }
    if (pw1 === oldPw) {
      setErr(t("auth.cp.same"));
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      await change(oldPw, pw1);
      notify("success", t("auth.cp.okTitle"), t("auth.cp.okDesc"));
    } catch (e: any) {
      setErr(e?.message ?? String(e));
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
            <KeyRound className="h-6 w-6 text-warning" />
          </div>
          <h1 className="text-xl font-semibold">{t("auth.cp.title")}</h1>
          <p className="text-sm text-muted">{t("auth.cp.subtitle")}</p>
        </header>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="space-y-4 rounded-2xl border border-border bg-surface/60 p-6 shadow-card backdrop-blur-xl"
        >
          <TextField
            label={t("auth.cp.old")}
            type="password"
            value={oldPw}
            onChange={(e) => setOldPw(e.target.value)}
            placeholder={t("form.cp.old.ph")}
            required
            autoFocus
          />
          <TextField
            label={t("auth.cp.new")}
            type="password"
            value={pw1}
            onChange={(e) => setPw1(e.target.value)}
            placeholder={t("form.cp.new.ph")}
            required
            hint={t("auth.cp.rule")}
          />
          <TextField
            label={t("auth.cp.confirm")}
            type="password"
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
            placeholder={t("form.cp.confirm.ph")}
            required
            error={err ?? undefined}
          />
          <Button type="submit" loading={loading} className="w-full">
            {t("auth.cp.submit")}
          </Button>
          <button
            type="button"
            onClick={() => void logout()}
            className="block w-full text-center text-xs text-muted hover:text-text"
          >
            {t("auth.cp.logout")}
          </button>
        </form>
      </div>
    </div>
  );
}

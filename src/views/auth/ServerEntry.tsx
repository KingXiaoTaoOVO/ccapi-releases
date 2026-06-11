import { useState } from "react";
import { ArrowLeft, Key } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { verifyEntryPassword } from "@/services/tauri";
import { useModeStore } from "@/store/useModeStore";
import { notify } from "@/services/notify";

interface Props {
  onPass: () => void;
}

export function ServerEntry({ onPass }: Props) {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 16 });
  const reset = useModeStore((s) => s.reset);
  const [pw, setPw] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!pw) {
      setErr(t("server.entry.empty"));
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const ok = await verifyEntryPassword(pw);
      if (ok) {
        onPass();
      } else {
        setErr(t("server.entry.wrong"));
      }
    } catch (e: any) {
      notify("error", t("server.entry.errorTitle"), e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div ref={ref} className="grid h-full place-items-center px-6 py-10">
      <div className="w-full max-w-md space-y-6">
        <header className="space-y-2 text-center">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-border bg-surface shadow-glow">
            <Key className="h-6 w-6 text-primary" />
          </div>
          <h1 className="text-xl font-semibold">{t("server.entry.title")}</h1>
          <p className="text-sm text-muted">{t("server.entry.subtitle")}</p>
        </header>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="space-y-4 rounded-2xl border border-border bg-surface/60 p-6 shadow-card backdrop-blur-xl"
        >
          <TextField
            label={t("server.entry.password")}
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder={t("server.entry.passwordPh")}
            error={err ?? undefined}
            autoFocus
            required
          />
          <Button type="submit" loading={loading} className="w-full">
            {t("server.entry.submit")}
          </Button>
          <div className="flex items-center justify-between text-xs text-muted">
            <button
              type="button"
              onClick={() => void reset()}
              className="flex items-center gap-1 hover:text-text"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              {t("server.entry.back")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

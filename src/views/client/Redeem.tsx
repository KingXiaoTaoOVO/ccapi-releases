import { useEffect, useState } from "react";
import { Loader2, Ticket } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { apiPost } from "@/services/apiClient";
import { notify } from "@/services/notify";
import { confirm } from "@/store/useConfirmStore";

export function Redeem() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 12 });
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    type: string;
    tier?: string | null;
    bonus?: string;
  } | null>(null);

  useEffect(() => {
    if (result) {
      const id = window.setTimeout(() => setResult(null), 8000);
      return () => window.clearTimeout(id);
    }
  }, [result]);

  const submit = async () => {
    const clean = code.trim().toUpperCase();
    if (!clean) {
      notify("error", t("client.redeem.empty"));
      return;
    }
    if (
      !(await confirm({
        title: t("client.redeem.confirmTitle"),
        description: t("client.redeem.confirmDesc", { code: clean }),
      }))
    )
      return;
    setLoading(true);
    try {
      const r = await apiPost<{
        codeType: string;
        tierApplied: string | null;
        bonusAdded: string;
      }>("/api/user/redeem", { code: clean });
      setResult({
        type: r.codeType,
        tier: r.tierApplied,
        bonus: r.bonusAdded,
      });
      setCode("");
      notify("success", t("client.redeem.done"));
    } catch (e: any) {
      notify("error", t("client.redeem.failTitle"), e?.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div ref={ref} className="grid h-full place-items-center px-6">
      <div className="w-full max-w-md space-y-5">
        <header className="space-y-2 text-center">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-border bg-surface shadow-glow">
            <Ticket className="h-6 w-6 text-primary" />
          </div>
          <h1 className="text-xl font-semibold">{t("client.redeem.title")}</h1>
          <p className="text-sm text-muted">{t("client.redeem.subtitle")}</p>
        </header>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="space-y-4 rounded-2xl border border-border bg-surface/60 p-6 shadow-card backdrop-blur-xl"
        >
          <TextField
            label={t("client.redeem.code")}
            placeholder="CCAPI-XXXX-XXXX-XXXX-XXXX"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            autoFocus
            required
            className="font-mono uppercase"
          />
          <Button type="submit" className="w-full" loading={loading}>
            {t("client.redeem.submit")}
          </Button>
        </form>

        {result && (
          <div className="rounded-2xl border border-success/40 bg-success/10 p-4 text-sm text-success">
            <p className="font-semibold">{t("client.redeem.done")}</p>
            <p className="mt-1 text-xs">
              {t("client.redeem.type")}: <span className="font-mono">{result.type}</span>
              {result.tier && ` · ${t("client.redeem.tier")}: ${result.tier}`}
              {result.bonus && ` · +$${result.bonus}`}
            </p>
          </div>
        )}
      </div>
      {/* dummy to silence */}
      {false && <Loader2 />}
    </div>
  );
}

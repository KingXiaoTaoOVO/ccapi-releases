import { useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, Loader2, Link2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { useModeStore } from "@/store/useModeStore";
import { cn } from "@/lib/cn";

interface Props {
  onConnected: () => void;
}

export function ServerUrlSetup({ onConnected }: Props) {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 16 });
  const reset = useModeStore((s) => s.reset);
  const storedUrl = useModeStore((s) => s.serverUrl);
  const remoteOk = useModeStore((s) => s.remoteOk);
  const remoteLatency = useModeStore((s) => s.remoteLatencyMs);
  const setServerUrl = useModeStore((s) => s.setServerUrl);
  const probe = useModeStore((s) => s.probe);

  const [url, setUrl] = useState(storedUrl ?? "http://127.0.0.1:8787");
  const [probing, setProbing] = useState(false);

  useEffect(() => {
    if (storedUrl) {
      setUrl(storedUrl);
      void probe();
    }
  }, [storedUrl, probe]);

  const onProbe = async () => {
    setProbing(true);
    try {
      await setServerUrl(url);
      const ok = await probe();
      if (ok) {
        setTimeout(() => onConnected(), 400);
      }
    } finally {
      setProbing(false);
    }
  };

  return (
    <div ref={ref} className="grid h-full place-items-center px-6 py-10">
      <div className="w-full max-w-md space-y-6">
        <header className="space-y-2 text-center">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-border bg-surface shadow-glow">
            <Link2 className="h-6 w-6 text-primary" />
          </div>
          <h1 className="text-xl font-semibold">{t("client.url.title")}</h1>
          <p className="text-sm text-muted">{t("client.url.subtitle")}</p>
        </header>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onProbe();
          }}
          className="space-y-4 rounded-2xl border border-border bg-surface/60 p-6 shadow-card backdrop-blur-xl"
        >
          <TextField
            label={t("client.url.label")}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://example.com:8787"
            autoFocus
            required
          />
          {remoteOk !== null && (
            <div
              className={cn(
                "flex items-center gap-2 rounded-xl border px-3 py-2.5 text-xs",
                remoteOk
                  ? "border-success/40 bg-success/10 text-success"
                  : "border-danger/40 bg-danger/10 text-danger",
              )}
            >
              {remoteOk ? (
                <>
                  <CheckCircle2 className="h-4 w-4" />
                  {t("client.url.ok", { ms: String(remoteLatency ?? 0) })}
                </>
              ) : (
                <>
                  <XCircle className="h-4 w-4" />
                  {t("client.url.fail")}
                </>
              )}
            </div>
          )}
          <div className="flex gap-2">
            <Button
              type="submit"
              loading={probing}
              className="flex-1"
            >
              {remoteOk ? t("client.url.continue") : t("client.url.connect")}
            </Button>
          </div>
          <button
            type="button"
            onClick={() => void reset()}
            className="flex items-center gap-1 text-xs text-muted hover:text-text"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {t("client.url.back")}
          </button>
        </form>
      </div>
    </div>
  );
}

// 让未用的 import 不报错
void Loader2;

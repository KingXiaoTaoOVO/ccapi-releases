import { useEffect, useRef, useState } from "react";
import {
  CircleCheckBig as CheckCircle2,
  Download,
  RefreshCw,
  ShieldAlert,
  Terminal,
  CircleX as XCircle,
} from "lucide-react";
import type { InstallDone, InstallLog } from "@/types";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import {
  cancelInstall,
  installClaude,
  installOptions,
  onInstallDone,
  onInstallLog,
  recommendInstallMethod,
} from "@/services/claudeInstall";
import { useAppStore } from "@/store/useAppStore";
import { toast } from "@/store/useToastStore";

export function InstallGuide() {
  const t = useT();
  const env = useAppStore((s) => s.claudeEnv);
  const detecting = useAppStore((s) => s.detecting);
  const refreshEnv = useAppStore((s) => s.refreshEnv);

  const [method, setMethod] = useState("npm");
  const [installing, setInstalling] = useState(false);
  const [logs, setLogs] = useState<InstallLog[]>([]);
  const [result, setResult] = useState<InstallDone | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const cardRef = useEntrance<HTMLDivElement>();

  const options = installOptions(env);
  const selected = options.find((o) => o.method === method);

  useEffect(() => {
    setMethod(recommendInstallMethod(env));
  }, [env]);

  // subscribe to install streaming events
  useEffect(() => {
    let unLog: (() => void) | undefined;
    let unDone: (() => void) | undefined;
    onInstallLog((l) => setLogs((prev) => [...prev, l])).then((f) => (unLog = f));
    onInstallDone((d) => {
      setInstalling(false);
      setResult(d);
      if (d.success) {
        toast.success(t("install.done"), t("install.ready"));
        setTimeout(() => refreshEnv(), 800);
      } else {
        toast.error(t("install.failed"), d.message);
      }
    }).then((f) => (unDone = f));
    return () => {
      unLog?.();
      unDone?.();
    };
  }, [refreshEnv]);

  // auto-scroll log view
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs]);

  const start = async () => {
    setLogs([]);
    setResult(null);
    setInstalling(true);
    try {
      await installClaude(method);
    } catch (e) {
      setInstalling(false);
      toast.error(t("install.startFailed"), String(e));
    }
  };

  const cancel = async () => {
    try {
      await cancelInstall();
      toast.info(t("install.canceled"));
    } catch (e) {
      toast.error(t("install.cancelFailed"), String(e));
    }
  };

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div ref={cardRef} className="card gradient-border w-full max-w-2xl p-8">
        <div className="flex items-center gap-3">
          <div className="grid h-12 w-12 place-items-center rounded-xl bg-warning/15 text-warning">
            <ShieldAlert className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">{t("install.title")}</h1>
            <p className="text-sm text-muted">
              {t("install.subtitle")}
            </p>
          </div>
        </div>

        {/* method selector */}
        <div className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {options.map((o) => (
            <button
              key={o.method}
              disabled={!o.available || installing}
              onClick={() => setMethod(o.method)}
              title={o.descriptionKey ? t(o.descriptionKey) : o.description}
              className={cn(
                "rounded-xl border px-3 py-2.5 text-sm font-medium transition-all",
                method === o.method
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-surface-2 text-muted hover:text-text",
                !o.available && "cursor-not-allowed opacity-40",
              )}
            >
              {o.labelKey ? t(o.labelKey) : o.label}
              {!o.available && o.method !== "native" && (
                <span className="block text-[10px]">{t("install.notInstalled")}</span>
              )}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">
          {selected?.descriptionKey ? t(selected.descriptionKey) : selected?.description}
        </p>

        {/* log console */}
        {(installing || logs.length > 0) && (
          <div className="mt-5">
            <div className="mb-1.5 flex items-center gap-2 text-xs text-muted">
              <Terminal className="h-3.5 w-3.5" /> {t("install.logTitle")}
            </div>
            <div
              ref={logRef}
              className="h-40 overflow-y-auto rounded-xl border border-border bg-[#0b0e10] p-3 font-mono text-xs leading-relaxed text-slate-300"
            >
              {logs.length === 0 && (
                <span className="text-slate-500">{t("install.waiting")}</span>
              )}
              {logs.map((l, i) => (
                <div
                  key={i}
                  className={cn(
                    "whitespace-pre-wrap break-all",
                    l.stream === "stderr" && "text-amber-400",
                    l.stream === "system" && "text-cyan-400",
                  )}
                >
                  {l.line}
                </div>
              ))}
            </div>
            {installing && (
              <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-surface-2">
                <div className="h-full w-1/3 animate-[shimmer_1.4s_infinite] rounded-full bg-primary" />
              </div>
            )}
          </div>
        )}

        {/* result banner */}
        {result && (
          <div
            className={cn(
              "mt-4 flex items-center gap-2 rounded-xl px-3 py-2 text-sm",
              result.success
                ? "bg-success/10 text-success"
                : "bg-danger/10 text-danger",
            )}
          >
            {result.success ? (
              <CheckCircle2 className="h-4 w-4" />
            ) : (
              <XCircle className="h-4 w-4" />
            )}
            {result.message}
          </div>
        )}

        {/* actions */}
        <div className="mt-6 flex items-center gap-2">
          {installing ? (
            <Button variant="danger" onClick={cancel}>
              {t("install.cancel")}
            </Button>
          ) : (
            <Button onClick={start}>
              <Download className="h-4 w-4" /> {t("install.oneClick")}
            </Button>
          )}
          <Button variant="secondary" onClick={refreshEnv} loading={detecting}>
            <RefreshCw className="h-4 w-4" /> {t("install.recheck")}
          </Button>
          <button
            onClick={refreshEnv}
            className="ml-auto text-xs text-muted hover:text-text"
          >
            {t("install.manualContinue")}
          </button>
        </div>
      </div>
    </div>
  );
}

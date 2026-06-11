import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Archive, Check, Loader2, Package, Trash2, X } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { useT } from "@/i18n";
import {
  onInstallLog,
  uninstallClaude,
  type TrayAction,
} from "@/services/tauri";
import type { UninstallOptions, UninstallReport, UninstallStep } from "@/types";
import { useAppStore } from "@/store/useAppStore";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import { toast } from "@/store/useToastStore";
import { cn } from "@/lib/cn";

interface UninstallModalProps {
  open: boolean;
  onClose: () => void;
}

const DEFAULT_OPTS: UninstallOptions = {
  removeGlobalPackage: true,
  removeNativeInstallDir: true,
  removeConfigDir: true,
  removeLegacyConfig: true,
  backupFirst: true,
  killProcesses: true,
  cleanRegistry: true,
  cleanPathEnv: true,
  emptyRecycleBin: false,
};

interface OptionRow {
  key: keyof UninstallOptions;
  labelKey: Parameters<ReturnType<typeof useT>>[0];
  descKey: Parameters<ReturnType<typeof useT>>[0];
  destructive?: boolean;
}

const OPTIONS: OptionRow[] = [
  {
    key: "backupFirst",
    labelKey: "uninstall.opt.backup",
    descKey: "uninstall.opt.backup.desc",
  },
  {
    key: "killProcesses",
    labelKey: "uninstall.opt.kill",
    descKey: "uninstall.opt.kill.desc",
    destructive: true,
  },
  {
    key: "removeGlobalPackage",
    labelKey: "uninstall.opt.global",
    descKey: "uninstall.opt.global.desc",
    destructive: true,
  },
  {
    key: "removeNativeInstallDir",
    labelKey: "uninstall.opt.native",
    descKey: "uninstall.opt.native.desc",
    destructive: true,
  },
  {
    key: "removeConfigDir",
    labelKey: "uninstall.opt.config",
    descKey: "uninstall.opt.config.desc",
    destructive: true,
  },
  {
    key: "removeLegacyConfig",
    labelKey: "uninstall.opt.legacy",
    descKey: "uninstall.opt.legacy.desc",
    destructive: true,
  },
  {
    key: "cleanRegistry",
    labelKey: "uninstall.opt.registry",
    descKey: "uninstall.opt.registry.desc",
    destructive: true,
  },
  {
    key: "cleanPathEnv",
    labelKey: "uninstall.opt.path",
    descKey: "uninstall.opt.path.desc",
    destructive: true,
  },
  {
    key: "emptyRecycleBin",
    labelKey: "uninstall.opt.recycle",
    descKey: "uninstall.opt.recycle.desc",
    destructive: true,
  },
];

// Unused import-only side-effect — keep `TrayAction` referenced so tree-shaking
// of `services/tauri.ts` doesn't drop it inadvertently. (Plain TS hoist guard.)
const _typeAnchor: TrayAction | null = null;
void _typeAnchor;

function formatBytes(n: number): string {
  if (n <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${u[i]}`;
}

function StepIcon({ status }: { status: UninstallStep["status"] }) {
  if (status === "ok") return <Check className="h-3.5 w-3.5 text-success" />;
  if (status === "failed") return <X className="h-3.5 w-3.5 text-danger" />;
  return <span className="h-3.5 w-3.5 rounded-full bg-muted/30" />;
}

export function UninstallModal({ open, onClose }: UninstallModalProps) {
  const t = useT();
  const refreshEnv = useAppStore((s) => s.refreshEnv);
  const wsLog = useWorkspaceStore((s) => s.log);

  const [opts, setOpts] = useState<UninstallOptions>(DEFAULT_OPTS);
  const [confirmText, setConfirmText] = useState("");
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<UninstallReport | null>(null);
  const [stream, setStream] = useState<string[]>([]);
  const unlistenRef = useRef<(() => void) | null>(null);

  // Reset form when re-opened.
  useEffect(() => {
    if (open) {
      setOpts(DEFAULT_OPTS);
      setConfirmText("");
      setRunning(false);
      setReport(null);
      setStream([]);
    }
  }, [open]);

  // Subscribe to the install-log channel (re-used for uninstall output).
  useEffect(() => {
    if (!open) return;
    let active = true;
    onInstallLog((log) => {
      if (!active) return;
      setStream((prev) => [...prev.slice(-200), `[${log.stream}] ${log.line}`]);
    }).then((un) => {
      unlistenRef.current = un;
    });
    return () => {
      active = false;
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, [open]);

  const setOpt = <K extends keyof UninstallOptions>(k: K, v: UninstallOptions[K]) =>
    setOpts((prev) => ({ ...prev, [k]: v }));

  const hasAnyDestructive =
    opts.removeGlobalPackage ||
    opts.removeNativeInstallDir ||
    opts.removeConfigDir ||
    opts.removeLegacyConfig ||
    opts.killProcesses ||
    opts.cleanRegistry ||
    opts.cleanPathEnv ||
    opts.emptyRecycleBin;

  const confirmPhrase = t("uninstall.confirmPhrase");
  const isConfirmed = confirmText.trim() === confirmPhrase;

  const run = async () => {
    if (!isConfirmed || running) return;
    setRunning(true);
    setStream([]);
    setReport(null);
    wsLog("info", "uninstall", t("uninstall.startedLog"));
    try {
      const result = await uninstallClaude(opts);
      setReport(result);
      if (result.success) {
        wsLog(
          "info",
          "uninstall",
          t("uninstall.successLog", { bytes: formatBytes(result.bytesRemoved) }),
        );
        toast.success(t("uninstall.toastSuccess"));
      } else {
        const failed = result.steps.filter((s) => s.status === "failed").length;
        wsLog(
          "warning",
          "uninstall",
          t("uninstall.partialLog", { failed: String(failed) }),
        );
        toast.warning(t("uninstall.toastPartial"));
      }
      // Refresh the env probe so the install banner reappears if everything
      // is gone.
      refreshEnv();
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      wsLog("error", "uninstall", t("uninstall.failedLog"), msg);
      toast.error(t("uninstall.toastFailed"), msg);
    } finally {
      setRunning(false);
    }
  };

  const close = () => {
    if (running) return;
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      disableDismiss={running}
      hideClose={running}
      size="lg"
      title={report ? t("uninstall.doneTitle") : t("uninstall.title")}
      description={report ? undefined : t("uninstall.desc")}
      footer={
        report ? (
          <Button onClick={close}>{t("uninstall.close")}</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close} disabled={running}>
              {t("ws.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={run}
              loading={running}
              disabled={!isConfirmed || !hasAnyDestructive || running}
            >
              {running ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              {running ? t("uninstall.running") : t("uninstall.runNow")}
            </Button>
          </>
        )
      }
    >
      {report ? (
        <div className="space-y-3">
          <div
            className={cn(
              "flex items-start gap-3 rounded-xl border p-3",
              report.success
                ? "border-success/40 bg-success/10 text-success"
                : "border-warning/40 bg-warning/10 text-warning",
            )}
          >
            {report.success ? (
              <Check className="h-4 w-4" />
            ) : (
              <AlertTriangle className="h-4 w-4" />
            )}
            <div className="text-sm">
              <p className="font-medium">
                {report.success ? t("uninstall.allOk") : t("uninstall.partial")}
              </p>
              <p className="text-xs opacity-80">
                {t("uninstall.bytesRemoved", {
                  bytes: formatBytes(report.bytesRemoved),
                })}
                {report.backupPath && ` · ${t("uninstall.backupAt")}: ${report.backupPath}`}
              </p>
            </div>
          </div>

          <ul className="space-y-1.5 text-sm">
            {report.steps.map((s, i) => (
              <li
                key={`${s.target}-${i}`}
                className="flex items-start gap-2 rounded-lg border border-border bg-surface-2/40 px-3 py-2"
              >
                <StepIcon status={s.status} />
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-[11px] text-muted">{s.target}</p>
                  <p className="text-xs">
                    {s.action} ·
                    <span
                      className={cn(
                        "ml-1 font-medium",
                        s.status === "ok"
                          ? "text-success"
                          : s.status === "failed"
                            ? "text-danger"
                            : "text-muted",
                      )}
                    >
                      {t(`uninstall.status.${s.status}` as never)}
                    </span>
                  </p>
                  {s.detail && (
                    <p className="mt-1 break-words text-[11px] text-muted">{s.detail}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-xl border border-danger/40 bg-danger/10 p-3 text-danger">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="text-xs leading-relaxed">{t("uninstall.warning")}</p>
          </div>

          <div className="space-y-2">
            {OPTIONS.map((row) => {
              const Icon = row.key === "backupFirst" ? Archive : Package;
              return (
                <label
                  key={row.key}
                  className="flex items-start gap-3 rounded-xl border border-border bg-surface-2/40 p-3"
                >
                  <span
                    className={cn(
                      "mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg",
                      row.destructive
                        ? "bg-danger/15 text-danger"
                        : "bg-primary/15 text-primary",
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{t(row.labelKey)}</p>
                    <p className="text-xs text-muted">{t(row.descKey)}</p>
                  </div>
                  <Switch
                    checked={!!opts[row.key]}
                    onChange={(v) => setOpt(row.key, v)}
                    disabled={running}
                  />
                </label>
              );
            })}
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted">
              {t("uninstall.typeToConfirm", { phrase: confirmPhrase })}
            </p>
            <input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={confirmPhrase}
              disabled={running}
              autoComplete="off"
              className={cn(
                "no-drag w-full rounded-xl border bg-surface-2 px-3.5 py-2.5 text-sm outline-none",
                "transition-[box-shadow,border-color] duration-200",
                isConfirmed
                  ? "border-danger/60 shadow-[0_0_0_3px_rgb(var(--danger)/0.18)]"
                  : "border-border focus:border-danger/40",
              )}
            />
          </div>

          {stream.length > 0 && (
            <pre className="max-h-32 overflow-y-auto rounded-xl bg-surface-2/60 p-3 font-mono text-[11px] leading-relaxed text-muted">
              {stream.join("\n")}
            </pre>
          )}
        </div>
      )}
    </Modal>
  );
}

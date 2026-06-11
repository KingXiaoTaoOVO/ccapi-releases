import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Loader2,
  RefreshCw,
  Terminal,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useT } from "@/i18n";
import {
  detectClaude,
  installClaudeSmart,
  onInstallDone,
  onInstallLog,
} from "@/services/tauri";
import { notify } from "@/services/notify";
import type { ClaudeEnvInfo } from "@/types";
import { UninstallModal } from "@/components/UninstallModal/UninstallModal";

/**
 * "Claude Code 环境" 控制面板 —
 *  - 显示当前安装状态 / 版本 / 路径 / 包管理器探测；
 *  - 未装：一键安装最新版（自动选择最佳 PM），安装日志实时滚动；
 *  - 已装：一键卸载（弹 UninstallModal，所有清理选项默认勾选）。
 *
 * 安装后会调用 detect_claude 探测，确认 `claude --version` 真的可用才算完成。
 */
export function ClaudeCodePanel() {
  const t = useT();
  const [info, setInfo] = useState<ClaudeEnvInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [chosenMethod, setChosenMethod] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [showUninstall, setShowUninstall] = useState(false);
  const logUnsubRef = useRef<(() => void) | null>(null);
  const doneUnsubRef = useRef<(() => void) | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const i = await detectClaude();
      setInfo(i);
    } catch (e: any) {
      notify("error", t("ccpanel.detectFail"), e?.message);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 安装期间订阅事件流，安装结束后自动取消
  useEffect(() => {
    if (!installing) return;
    let cancelled = false;
    onInstallLog((l) => {
      if (cancelled) return;
      setLogLines((prev) => [...prev.slice(-300), `[${l.stream}] ${l.line}`]);
    }).then((un) => {
      logUnsubRef.current = un;
    });
    onInstallDone((d) => {
      if (cancelled) return;
      // 不在事件里直接 setInstalling(false)，等 detect 验证完毕再切
      void (async () => {
        await refresh();
        const probe = await detectClaude();
        const ok = d.success && probe.installed && probe.version;
        if (ok) {
          notify(
            "success",
            t("ccpanel.installOk"),
            t("ccpanel.installOkDesc", { version: probe.version ?? "?" }),
          );
        } else if (d.success) {
          notify("warning", t("ccpanel.installPartial"), d.message);
        } else {
          notify("error", t("ccpanel.installFail"), d.message);
        }
        setInstalling(false);
      })();
    }).then((un) => {
      doneUnsubRef.current = un;
    });
    return () => {
      cancelled = true;
      logUnsubRef.current?.();
      logUnsubRef.current = null;
      doneUnsubRef.current?.();
      doneUnsubRef.current = null;
    };
  }, [installing, refresh, t]);

  const startInstall = async () => {
    setLogLines([]);
    setInstalling(true);
    try {
      const m = await installClaudeSmart();
      setChosenMethod(m);
    } catch (e: any) {
      setInstalling(false);
      notify("error", t("ccpanel.installFail"), e?.message);
    }
  };

  const installed = info?.installed ?? false;
  const pmAvailable = info?.packageManagers.filter((p) => p.available) ?? [];

  return (
    <section className="space-y-4 rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div
            className={
              "grid h-12 w-12 shrink-0 place-items-center rounded-2xl " +
              (installed ? "bg-success/15 text-success" : "bg-warning/15 text-warning")
            }
          >
            <Terminal className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-base font-semibold">
              {t("ccpanel.title")}
            </h2>
            <p className="mt-0.5 text-xs text-muted">{t("ccpanel.subtitle")}</p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void refresh()}
          disabled={loading || installing}
        >
          <RefreshCw
            className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"}
          />
          {t("common.refresh")}
        </Button>
      </header>

      {/* 状态卡 */}
      {info && (
        <div
          className={
            "rounded-xl border px-4 py-3 " +
            (installed
              ? "border-success/40 bg-success/10"
              : "border-warning/40 bg-warning/10")
          }
        >
          <div className="flex items-center gap-2 text-sm">
            {installed ? (
              <CheckCircle2 className="h-4 w-4 text-success" />
            ) : (
              <AlertTriangle className="h-4 w-4 text-warning" />
            )}
            <span className="font-medium">
              {installed
                ? t("ccpanel.statusInstalled", { v: info.version ?? "?" })
                : t("ccpanel.statusMissing")}
            </span>
          </div>
          {installed && (
            <dl className="mt-3 grid grid-cols-1 gap-1.5 text-xs sm:grid-cols-2">
              <div>
                <dt className="text-muted">{t("ccpanel.field.binary")}</dt>
                <dd className="break-all font-mono">
                  {info.binaryPath ?? "-"}
                </dd>
              </div>
              <div>
                <dt className="text-muted">{t("ccpanel.field.method")}</dt>
                <dd className="font-mono">{info.installMethod ?? "-"}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-muted">{t("ccpanel.field.configDir")}</dt>
                <dd className="break-all font-mono">
                  {info.configDir}
                  {info.configDirExists ? "" : ` (${t("ccpanel.notExist")})`}
                </dd>
              </div>
            </dl>
          )}
          {!installed && (
            <p className="mt-1 text-xs text-muted">
              {pmAvailable.length === 0
                ? t("ccpanel.noPm")
                : t("ccpanel.detectedPm", {
                    list: pmAvailable
                      .map((p) => `${p.name}${p.version ? ` ${p.version.split("\n")[0]}` : ""}`)
                      .join(", "),
                  })}
            </p>
          )}
        </div>
      )}

      {/* 行动按钮 */}
      <div className="flex flex-wrap gap-2">
        {!installed && (
          <Button onClick={() => void startInstall()} loading={installing} disabled={installing}>
            <Download className="h-4 w-4" />
            {installing
              ? t("ccpanel.installing", { method: chosenMethod ?? "..." })
              : t("ccpanel.installNow")}
          </Button>
        )}
        {installed && (
          <Button
            variant="ghost"
            onClick={() => setShowUninstall(true)}
            disabled={installing}
            className="text-danger hover:bg-danger/10"
          >
            <Trash2 className="h-4 w-4" />
            {t("ccpanel.uninstall")}
          </Button>
        )}
      </div>

      {/* 安装日志 */}
      {(installing || logLines.length > 0) && (
        <div className="rounded-xl border border-border bg-surface-2/60">
          <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-xs text-muted">
            {installing && <Loader2 className="h-3 w-3 animate-spin" />}
            <span className="font-medium">
              {installing
                ? t("ccpanel.installLogLive", { method: chosenMethod ?? "?" })
                : t("ccpanel.installLogDone")}
            </span>
          </div>
          <pre className="max-h-44 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed text-muted whitespace-pre-wrap">
            {logLines.join("\n") || t("ccpanel.logWaiting")}
          </pre>
        </div>
      )}

      <UninstallModal
        open={showUninstall}
        onClose={() => {
          setShowUninstall(false);
          // 关闭后立即重新探测一次
          void refresh();
        }}
      />
    </section>
  );
}

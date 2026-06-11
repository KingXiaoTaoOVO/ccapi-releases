import { useEffect, useState } from "react";
import { ArrowLeft, Loader2, RefreshCw, WifiOff } from "lucide-react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/Button";
import { useT } from "@/i18n";
import { useAuthStore } from "@/store/useAuthStore";
import { useModeStore } from "@/store/useModeStore";
import { useReconnectStore } from "@/store/useReconnectStore";

/**
 * 全屏蒙层：仅在客户端模式登录后启动，并且 reconnect store 标记 offline 时显示。
 * 提供两个出口：手动立刻重试 / 退出回到模式选择（清 session + 清 mode）。
 */
export function ReconnectOverlay() {
  const t = useT();
  const offline = useReconnectStore((s) => s.offline);
  const failures = useReconnectStore((s) => s.failures);
  const attempts = useReconnectStore((s) => s.attempts);
  const nextRetryInSecs = useReconnectStore((s) => s.nextRetryInSecs);
  const retryNow = useReconnectStore((s) => s.retryNow);

  const serverUrl = useModeStore((s) => s.serverUrl);
  const resetMode = useModeStore((s) => s.reset);
  const logout = useAuthStore((s) => s.logout);

  const [retrying, setRetrying] = useState(false);

  // 离开蒙层时清理状态
  useEffect(() => {
    if (!offline) setRetrying(false);
  }, [offline]);

  if (!offline) return null;

  const onRetry = async () => {
    setRetrying(true);
    try {
      await retryNow();
    } finally {
      setRetrying(false);
    }
  };

  const onExit = async () => {
    useReconnectStore.getState().stop();
    try {
      await logout();
    } catch {
      /* ignore */
    }
    await resetMode();
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 backdrop-blur-md">
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface/95 p-6 shadow-card backdrop-blur-xl">
        <div className="flex flex-col items-center text-center">
          <div className="relative grid h-16 w-16 place-items-center rounded-2xl border border-warning/30 bg-warning/10 text-warning">
            <WifiOff className="h-7 w-7" />
            <Loader2 className="absolute -bottom-1 -right-1 h-5 w-5 animate-spin text-warning" />
          </div>
          <h2 className="mt-4 text-lg font-semibold">
            {t("reconnect.title")}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {t("reconnect.desc", { url: serverUrl ?? "-" })}
          </p>
        </div>

        <div className="mt-5 space-y-1.5 rounded-xl border border-border bg-surface-2/60 px-4 py-3 text-xs text-muted">
          <div className="flex items-center justify-between">
            <span>{t("reconnect.failures")}</span>
            <span className="font-mono text-text">{failures}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>{t("reconnect.attempts")}</span>
            <span className="font-mono text-text">{attempts}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>{t("reconnect.nextRetry")}</span>
            <span className="font-mono text-text">
              {retrying || nextRetryInSecs === 0
                ? t("reconnect.tryingNow")
                : t("reconnect.inSecs", { n: String(nextRetryInSecs) })}
            </span>
          </div>
        </div>

        <div className="mt-5 flex flex-col gap-2">
          <Button
            onClick={() => void onRetry()}
            loading={retrying}
            className="w-full"
          >
            <RefreshCw className="h-4 w-4" />
            {t("reconnect.retryNow")}
          </Button>
          <Button
            variant="ghost"
            onClick={() => void onExit()}
            className="w-full text-muted hover:text-text"
          >
            <ArrowLeft className="h-4 w-4" />
            {t("reconnect.exitToModeSelect")}
          </Button>
        </div>

        <p className="mt-4 text-center text-[11px] leading-relaxed text-muted/80">
          {t("reconnect.tip")}
        </p>
      </div>
    </div>,
    document.body,
  );
}

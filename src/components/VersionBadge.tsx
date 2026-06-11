import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Download, RefreshCw, Sparkles } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useT } from "@/i18n";
import { useServerInfoStore } from "@/store/useServerInfoStore";
import { notify } from "@/services/notify";

interface VersionInfo {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  releaseUrl: string | null;
  releaseName: string | null;
  releaseBody: string | null;
  publishedAt: string | null;
  error: string | null;
}

/** 侧栏底部显示的版本徽标 —— 点击弹检查更新对话框。 */
export function VersionBadge() {
  const t = useT();
  const [current, setCurrent] = useState<string>("");
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [checking, setChecking] = useState(false);
  // 直接从中心 store 读 —— App.tsx 已经在 serverUrl 变化时同步
  const serverInfo = useServerInfoStore((s) => s.info);

  useEffect(() => {
    invoke<string>("get_app_version")
      .then(setCurrent)
      .catch(() => setCurrent(""));
  }, []);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      // 从已同步的服务端 site_info 读 updateRepo；fallback 由 Rust 端兜底
      const repo = serverInfo?.site?.updateRepo;
      const result = await invoke<VersionInfo>("check_github_release", { repo });
      setInfo(result);
      if (result.error) {
        notify("warning", t("ver.checkFailed"), result.error);
      } else if (result.hasUpdate) {
        notify("info", t("ver.updateAvailable", { v: result.latest ?? "?" }));
      } else {
        notify("success", t("ver.latest"));
      }
    } catch (e: any) {
      notify("error", t("ver.checkFailed"), e?.message ?? String(e));
    } finally {
      setChecking(false);
    }
  }, [t, serverInfo]);

  const openInfo = () => {
    setOpen(true);
    if (!info) {
      void check();
    }
  };

  return (
    <>
      <button
        onClick={openInfo}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-surface/50 px-2 py-1 text-[10px] text-muted transition-colors hover:border-primary/40 hover:text-text"
      >
        <Sparkles className="h-3 w-3" />
        <span className="tabular-nums">v{current || "?"}</span>
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t("ver.title")}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => void check()} loading={checking}>
              <RefreshCw className={checking ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
              {t("ver.recheck")}
            </Button>
            {info?.hasUpdate && info.releaseUrl ? (
              <Button
                onClick={() => {
                  if (info.releaseUrl) {
                    void openUrl(info.releaseUrl).catch(() => {});
                  }
                }}
              >
                <Download className="h-3.5 w-3.5" />
                {t("ver.openRelease")}
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => setOpen(false)}>
                {t("confirm.close")}
              </Button>
            )}
          </>
        }
      >
        <div className="space-y-3">
          <div className="rounded-xl border border-border bg-surface-2/40 p-3 text-sm">
            <p>
              <span className="text-muted">{t("ver.current")}：</span>
              <code className="font-mono">v{current || "?"}</code>
            </p>
            {info?.latest && (
              <p className="mt-1">
                <span className="text-muted">{t("ver.latest.label")}：</span>
                <code className="font-mono">v{info.latest}</code>
              </p>
            )}
          </div>

          {info?.error ? (
            <div className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              {info.error}
            </div>
          ) : info ? (
            info.hasUpdate ? (
              <div className="rounded-xl border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-primary">
                <p className="flex items-center gap-1.5 font-medium">
                  <Sparkles className="h-3.5 w-3.5" />
                  {t("ver.updateAvailable", { v: info.latest ?? "?" })}
                </p>
                {info.releaseName && (
                  <p className="mt-1 text-xs">{info.releaseName}</p>
                )}
                {info.publishedAt && (
                  <p className="mt-0.5 text-[11px] text-muted">
                    {new Date(info.publishedAt).toLocaleString()}
                  </p>
                )}
                {info.releaseBody && (
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-surface/60 p-2 text-[11px] leading-relaxed text-text">
                    {info.releaseBody}
                  </pre>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-xl border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
                <CheckCircle2 className="h-4 w-4" />
                {t("ver.latest")}
              </div>
            )
          ) : checking ? (
            <div className="text-center text-xs text-muted">
              {t("ver.checking")}
            </div>
          ) : null}
        </div>
      </Modal>
    </>
  );
}

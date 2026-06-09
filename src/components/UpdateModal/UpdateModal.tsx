import { useMemo } from "react";
import { ArrowUpCircle, Download, Loader2, RefreshCcw } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useT } from "@/i18n";
import { useUpdateStore } from "@/store/useUpdateStore";

function formatBytes(n?: number): string {
  if (!n || n <= 0) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${u[i]}`;
}

export function UpdateModal() {
  const t = useT();
  const open = useUpdateStore((s) => s.modalOpen);
  const phase = useUpdateStore((s) => s.phase);
  const info = useUpdateStore((s) => s.info);
  const progress = useUpdateStore((s) => s.progress);
  const error = useUpdateStore((s) => s.error);
  const closeModal = useUpdateStore((s) => s.closeModal);
  const startInstall = useUpdateStore((s) => s.startInstall);

  const pct = useMemo(() => {
    if (!progress?.total) return null;
    return Math.min(100, Math.round((progress.downloaded / progress.total) * 100));
  }, [progress]);

  const installing = phase === "installing";
  const ready = phase === "ready";

  return (
    <Modal
      open={open}
      onClose={closeModal}
      disableDismiss={installing}
      hideClose={installing}
      size="lg"
      title={ready ? t("update.readyTitle") : t("update.foundTitle")}
      description={
        info
          ? t("update.foundDesc", {
              current: info.currentVersion,
              next: info.version,
            })
          : undefined
      }
      footer={
        <>
          {!installing && !ready && (
            <Button variant="ghost" onClick={closeModal}>
              {t("update.later")}
            </Button>
          )}
          {ready ? (
            <Button onClick={closeModal}>{t("update.relaunchHint")}</Button>
          ) : (
            <Button
              onClick={startInstall}
              loading={installing}
              disabled={!info || installing}
            >
              {installing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              {installing ? t("update.installing") : t("update.installNow")}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-2xl border border-primary/30 bg-primary/5 p-4">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/15 text-primary">
            <ArrowUpCircle className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t("update.notesTitle")}</p>
            <pre className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-xl bg-surface-2/60 p-3 text-xs leading-relaxed text-text">
              {info?.notes?.trim() || t("update.noNotes")}
            </pre>
          </div>
        </div>

        {installing && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-muted">
              <span className="flex items-center gap-1.5">
                <RefreshCcw className="h-3.5 w-3.5 animate-spin" />
                {t("update.downloading")}
              </span>
              <span className="tabular-nums">
                {formatBytes(progress?.downloaded)} / {formatBytes(progress?.total)}
                {pct !== null && ` · ${pct}%`}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full bg-primary transition-[width] duration-200"
                style={{ width: pct === null ? "40%" : `${pct}%` }}
              />
            </div>
          </div>
        )}

        {error && phase === "error" && (
          <p className="rounded-xl border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

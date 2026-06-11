import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { TextField } from "@/components/ui/TextField";
import { useT } from "@/i18n";

export type ConfirmLevel = "info" | "danger" | "critical";

export interface ConfirmRequest {
  title: string;
  description?: string;
  /** 危险等级：info 普通；danger 需要点两次；critical 需要输入确认字符串 */
  level?: ConfirmLevel;
  /** critical 等级下需要用户准确输入这个字符串才能确认 */
  confirmText?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

interface ConfirmDialogProps {
  open: boolean;
  request: ConfirmRequest | null;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  request,
  loading,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const t = useT();
  const [typed, setTyped] = useState("");
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    if (open) setTyped("");
  }, [open]);

  // critical 等级：弹窗打开后按钮置灰 3 秒，避免误手疾点
  useEffect(() => {
    if (!open || request?.level !== "critical") {
      setCountdown(0);
      return;
    }
    setCountdown(3);
    const id = window.setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          window.clearInterval(id);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [open, request?.level]);

  if (!request) return null;

  const level = request.level ?? "info";
  const requiresText = level === "critical" && !!request.confirmText;
  const canConfirm =
    (!requiresText || typed === request.confirmText) && countdown === 0;

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={request.title}
      description={request.description}
      size="sm"
      disableDismiss={level === "critical"}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={loading}>
            {request.cancelLabel ?? t("confirm.cancel")}
          </Button>
          <Button
            variant={level === "info" ? "primary" : "danger"}
            onClick={onConfirm}
            disabled={!canConfirm}
            loading={loading}
          >
            {request.confirmLabel ?? t("confirm.confirm")}
            {countdown > 0 ? ` (${countdown}s)` : ""}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {level !== "info" && (
          <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <p className="text-xs leading-relaxed text-warning">
              {t("confirm.warningHint")}
            </p>
          </div>
        )}
        {requiresText && (
          <TextField
            label={t("confirm.typeToConfirm", {
              text: request.confirmText ?? "",
            })}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoFocus
          />
        )}
      </div>
    </Modal>
  );
}

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { TextArea, TextField } from "@/components/ui/TextField";
import { useT } from "@/i18n";

export type PromptFieldType = "text" | "password" | "number" | "textarea";

export interface PromptField {
  name: string;
  label: string;
  type?: PromptFieldType;
  placeholder?: string;
  hint?: string;
  defaultValue?: string;
  required?: boolean;
  autoFocus?: boolean;
  /** 返回 null 通过；返回 string 是错误提示 */
  validate?: (value: string, all: Record<string, string>) => string | null;
}

export interface PromptRequest {
  title: string;
  description?: string;
  fields: PromptField[];
  confirmLabel?: string;
  cancelLabel?: string;
  /** 危险动作：按钮变红 + 顶部警告条。封号/冻结/删除等用。 */
  danger?: boolean;
}

interface PromptDialogProps {
  open: boolean;
  request: PromptRequest | null;
  loading?: boolean;
  onConfirm: (values: Record<string, string>) => void;
  onCancel: () => void;
}

export function PromptDialog({
  open,
  request,
  loading,
  onConfirm,
  onCancel,
}: PromptDialogProps) {
  const t = useT();
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open || !request) return;
    const init: Record<string, string> = {};
    for (const f of request.fields) init[f.name] = f.defaultValue ?? "";
    setValues(init);
    setErrors({});
  }, [open, request]);

  const canSubmit = useMemo(() => {
    if (!request) return false;
    for (const f of request.fields) {
      const v = values[f.name] ?? "";
      if (f.required && !v.trim()) return false;
    }
    return true;
  }, [request, values]);

  if (!request) return null;

  const submit = () => {
    const nextErr: Record<string, string> = {};
    for (const f of request.fields) {
      const v = values[f.name] ?? "";
      if (f.required && !v.trim()) {
        nextErr[f.name] = t("prompt.required");
        continue;
      }
      if (f.validate) {
        const e = f.validate(v, values);
        if (e) nextErr[f.name] = e;
      }
    }
    if (Object.keys(nextErr).length) {
      setErrors(nextErr);
      return;
    }
    onConfirm(values);
  };

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={request.title}
      description={request.description}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={loading}>
            {request.cancelLabel ?? t("confirm.cancel")}
          </Button>
          <Button
            variant={request.danger ? "danger" : "primary"}
            onClick={submit}
            disabled={!canSubmit}
            loading={loading}
          >
            {request.confirmLabel ?? t("confirm.confirm")}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="space-y-3"
      >
        {request.danger && (
          <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <p className="text-xs leading-relaxed text-warning">
              {t("confirm.warningHint")}
            </p>
          </div>
        )}
        {request.fields.map((f, idx) => {
          const isFirst = idx === 0;
          const v = values[f.name] ?? "";
          const onChange = (nv: string) => {
            setValues((s) => ({ ...s, [f.name]: nv }));
            if (errors[f.name]) {
              setErrors((s) => {
                const c = { ...s };
                delete c[f.name];
                return c;
              });
            }
          };
          if (f.type === "textarea") {
            return (
              <TextArea
                key={f.name}
                label={f.label}
                rows={3}
                value={v}
                onChange={(e) => onChange(e.target.value)}
                placeholder={f.placeholder}
                hint={f.hint}
                error={errors[f.name]}
                required={f.required}
                autoFocus={f.autoFocus ?? isFirst}
              />
            );
          }
          return (
            <TextField
              key={f.name}
              label={f.label}
              type={f.type ?? "text"}
              value={v}
              onChange={(e) => onChange(e.target.value)}
              placeholder={f.placeholder}
              hint={f.hint}
              error={errors[f.name]}
              required={f.required}
              autoFocus={f.autoFocus ?? isFirst}
            />
          );
        })}
        {/* 隐藏的 submit 按钮，让回车键也能提交 */}
        <button type="submit" className="hidden" aria-hidden="true" />
      </form>
    </Modal>
  );
}

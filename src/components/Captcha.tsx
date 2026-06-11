import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { apiGet } from "@/services/apiClient";
import { Field } from "@/components/ui/TextField";
import { cn } from "@/lib/cn";
import { useT } from "@/i18n";

interface CaptchaProps {
  captchaId: string;
  answer: string;
  onIdChange: (id: string) => void;
  onAnswerChange: (a: string) => void;
  error?: string;
  /** 每次该值变化时强制重新拉取一张新验证码图（用于"输入错误自动刷新"） */
  reloadKey?: number;
}

export function Captcha({
  captchaId,
  answer,
  onIdChange,
  onAnswerChange,
  error,
  reloadKey,
}: CaptchaProps) {
  const t = useT();
  const [image, setImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await apiGet<{ captchaId: string; imageBase64: string }>(
        "/api/captcha/new",
        { auth: false },
      );
      setImage(d.imageBase64);
      onIdChange(d.captchaId);
      onAnswerChange("");
    } finally {
      setLoading(false);
    }
  }, [onIdChange, onAnswerChange]);

  useEffect(() => {
    void load();
  }, [load]);

  // 外部触发刷新（密码错误 / 验证码错误时）
  useEffect(() => {
    if (reloadKey === undefined || reloadKey === 0) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  // 保留 captchaId 引用（外部受控）
  void captchaId;

  return (
    <Field label={t("captcha.label")} error={error}>
      <div className="flex items-stretch gap-2">
        <input
          value={answer}
          onChange={(e) => onAnswerChange(e.target.value)}
          placeholder={t("captcha.placeholder")}
          maxLength={6}
          className={cn(
            "no-drag h-10 w-full rounded-xl border border-border bg-surface-2 px-3 text-sm tracking-widest",
            "focus:border-primary/60 focus:shadow-[0_0_0_3px_rgb(var(--primary)/0.18)] focus:outline-none",
            error && "border-danger/60",
          )}
        />
        <button
          type="button"
          onClick={() => void load()}
          title={t("captcha.refresh")}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-border bg-surface-2 transition-colors hover:border-primary/40"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </button>
        {image ? (
          <button
            type="button"
            onClick={() => void load()}
            title={t("captcha.refresh")}
            className="grid h-10 shrink-0 place-items-center overflow-hidden rounded-xl border border-border bg-white"
          >
            <img src={image} alt="captcha" className="h-full" />
          </button>
        ) : (
          <div className="h-10 w-40 rounded-xl border border-border bg-surface-2" />
        )}
      </div>
    </Field>
  );
}

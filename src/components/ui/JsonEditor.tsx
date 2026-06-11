import { useMemo } from "react";
import { AlertCircle, CheckCircle2 } from "lucide-react";

interface Props {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
  /** 允许空字符串（不校验） */
  allowEmpty?: boolean;
  className?: string;
  hint?: string;
}

/**
 * 务实版 JSON 编辑器：textarea + 实时校验 + 行/列错误指示 + 格式化按钮。
 * （task.txt 建议 monaco-editor，但 monaco 会增加 10MB+ bundle；本组件覆盖
 *   90% 真实需求——JSON 语法校验，不引入巨型依赖。）
 */
export function JsonEditor({
  value,
  onChange,
  rows = 6,
  placeholder,
  allowEmpty = true,
  className = "",
  hint,
}: Props) {
  const validation = useMemo(() => {
    if (!value.trim()) {
      return { ok: allowEmpty, error: null as string | null };
    }
    try {
      JSON.parse(value);
      return { ok: true, error: null };
    } catch (e: any) {
      let msg = e?.message ?? String(e);
      // SyntaxError: Unexpected token } in JSON at position 42
      const m = msg.match(/position (\d+)/);
      if (m) {
        const pos = Number(m[1]);
        const before = value.slice(0, pos);
        const line = before.split("\n").length;
        const col = before.length - before.lastIndexOf("\n");
        msg = `${msg} → 行 ${line} 列 ${col}`;
      }
      return { ok: false, error: msg };
    }
  }, [value, allowEmpty]);

  const format = () => {
    if (!value.trim()) return;
    try {
      onChange(JSON.stringify(JSON.parse(value), null, 2));
    } catch {
      /* 校验已显示，按钮一声不响 */
    }
  };

  return (
    <div className={className}>
      <div className="relative">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={rows}
          placeholder={placeholder}
          spellCheck={false}
          className={
            "w-full rounded-xl border bg-surface-2 px-3.5 py-2.5 font-mono text-xs outline-none transition-colors no-drag " +
            (validation.ok
              ? "border-border focus:border-primary/60"
              : "border-danger/40 focus:border-danger")
          }
        />
        <button
          type="button"
          onClick={format}
          className="absolute right-2 top-2 rounded-md border border-border bg-surface px-2 py-0.5 text-[10px] text-muted hover:text-text"
          title="JSON 格式化"
        >
          { }
        </button>
      </div>
      <div className="mt-1 flex items-start gap-1.5">
        {validation.ok ? (
          <>
            <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-success/80" />
            <p className="text-[11px] text-muted/80">{hint ?? "JSON 合法"}</p>
          </>
        ) : (
          <>
            <AlertCircle className="mt-0.5 h-3 w-3 shrink-0 text-danger" />
            <p className="text-[11px] text-danger/90">{validation.error}</p>
          </>
        )}
      </div>
    </div>
  );
}

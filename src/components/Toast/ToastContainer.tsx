import { useLayoutEffect, useRef } from "react";
import {
  TriangleAlert as AlertTriangle,
  CircleCheckBig as CheckCircle2,
  Info,
  CircleX as XCircle,
  X,
} from "lucide-react";
import gsap from "gsap";
import { cn } from "@/lib/cn";
import { prefersReducedMotion } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { useToastStore, type ToastItem, type ToastTone } from "@/store/useToastStore";

const TONE: Record<
  ToastTone,
  { icon: typeof Info; text: string }
> = {
  success: { icon: CheckCircle2, text: "text-success" },
  error: { icon: XCircle, text: "text-danger" },
  warning: { icon: AlertTriangle, text: "text-warning" },
  info: { icon: Info, text: "text-info" },
};

function Toast({ toast }: { toast: ToastItem }) {
  const dismiss = useToastStore((s) => s.dismiss);
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const tone = TONE[toast.tone];
  const Icon = tone.icon;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;
    gsap.fromTo(
      el,
      { x: 64, opacity: 0, scale: 0.92 },
      { x: 0, opacity: 1, scale: 1, duration: 0.45, ease: "power3.out" },
    );
  }, []);

  const close = () => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return dismiss(toast.id);
    gsap.to(el, {
      x: 64,
      opacity: 0,
      scale: 0.95,
      duration: 0.25,
      ease: "power2.in",
      onComplete: () => dismiss(toast.id),
    });
  };

  return (
    <div
      ref={ref}
      className="glass pointer-events-auto relative w-80 overflow-hidden rounded-xl border border-border shadow-card"
    >
      <div className="flex items-start gap-3 py-3 pl-4 pr-3">
        <Icon className={cn("mt-0.5 h-5 w-5 shrink-0", tone.text)} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-text">{toast.title}</p>
          {toast.message && (
            <p className="mt-0.5 break-words text-xs text-muted">{toast.message}</p>
          )}
        </div>
        <button
          onClick={close}
          className="-mr-1 rounded-md p-1 text-muted hover:bg-surface-2 hover:text-text"
          aria-label={t("a11y.closeNotice")}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[60] flex flex-col gap-2.5">
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} />
      ))}
    </div>
  );
}

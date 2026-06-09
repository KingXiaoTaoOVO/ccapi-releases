import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import gsap from "gsap";
import { cn } from "@/lib/cn";
import { prefersReducedMotion } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";

type Size = "sm" | "md" | "lg" | "xl";

const SIZES: Record<Size, string> = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
};

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  size?: Size;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Hide the close (X) button. */
  hideClose?: boolean;
  /** Disallow closing via backdrop / Esc (e.g. blocking flows). */
  disableDismiss?: boolean;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  size = "md",
  children,
  footer,
  hideClose,
  disableDismiss,
}: ModalProps) {
  const t = useT();
  const [mounted, setMounted] = useState(open);
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Mount as soon as we're asked to open.
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  // Enter animation
  useLayoutEffect(() => {
    if (!open || !mounted) return;
    const overlay = overlayRef.current;
    const panel = panelRef.current;
    if (!overlay || !panel) return;
    if (prefersReducedMotion()) {
      gsap.set([overlay, panel], { opacity: 1, y: 0, scale: 1 });
      return;
    }
    gsap.fromTo(overlay, { opacity: 0 }, { opacity: 1, duration: 0.25, ease: "power2.out" });
    gsap.fromTo(
      panel,
      { opacity: 0, y: 24, scale: 0.96 },
      { opacity: 1, y: 0, scale: 1, duration: 0.4, ease: "power3.out" },
    );
  }, [open, mounted]);

  // Exit animation — driven by `open` going false (from the X, Esc, backdrop,
  // OR any parent-controlled close such as a Cancel button). This is the single
  // place the modal unmounts, so every close path behaves identically.
  useLayoutEffect(() => {
    if (open || !mounted) return;
    const overlay = overlayRef.current;
    const panel = panelRef.current;
    if (!overlay || !panel || prefersReducedMotion()) {
      setMounted(false);
      return;
    }
    gsap.to(panel, { opacity: 0, y: 16, scale: 0.97, duration: 0.2, ease: "power2.in" });
    gsap.to(overlay, {
      opacity: 0,
      duration: 0.25,
      delay: 0.04,
      onComplete: () => setMounted(false),
    });
  }, [open, mounted]);

  // Ask the parent to close (it flips `open`, which runs the exit effect above).
  const requestClose = () => {
    if (disableDismiss) return;
    onClose();
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!mounted) return null;

  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        className={cn(
          "relative w-full glass rounded-2xl shadow-card gradient-border",
          "max-h-[88vh] flex flex-col",
          SIZES[size],
        )}
      >
        {(title || !hideClose) && (
          <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-3 border-b border-border/70">
            <div>
              {title && <h2 className="text-lg font-semibold">{title}</h2>}
              {description && (
                <p className="mt-0.5 text-sm text-muted">{description}</p>
              )}
            </div>
            {!hideClose && (
              <button
                onClick={requestClose}
                className="no-drag -mr-1 -mt-1 rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-text transition-colors"
                aria-label={t("a11y.close")}
              >
                <X className="h-5 w-5" />
              </button>
            )}
          </div>
        )}
        <div className="flex-1 overflow-y-auto px-6 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border/70">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

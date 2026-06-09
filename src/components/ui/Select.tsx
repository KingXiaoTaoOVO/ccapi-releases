import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import gsap from "gsap";
import { cn } from "@/lib/cn";
import { prefersReducedMotion } from "@/hooks/useGSAPAnim";
import { Field } from "./TextField";

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  label?: string;
  hint?: string;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
}

/**
 * Custom glass dropdown — replaces the native <select> with a styled,
 * GSAP-animated popover rendered in a portal (so it escapes overflow clipping
 * inside modals). Controlled via value / onValueChange.
 */
export function Select({
  value,
  onValueChange,
  options,
  label,
  hint,
  disabled,
  className,
  placeholder,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);

  const place = () => {
    const el = triggerRef.current;
    if (el) setRect(el.getBoundingClientRect());
  };

  const openMenu = () => {
    if (disabled) return;
    place();
    setOpen(true);
  };

  // Close on outside click / Esc / scroll / resize.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        !triggerRef.current?.contains(t) &&
        !menuRef.current?.contains(t)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onScroll = () => setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onScroll);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  // Entry animation
  useLayoutEffect(() => {
    if (!open || !menuRef.current || prefersReducedMotion()) return;
    gsap.fromTo(
      menuRef.current,
      { opacity: 0, y: -8, scale: 0.97 },
      { opacity: 1, y: 0, scale: 1, duration: 0.22, ease: "power3.out", transformOrigin: "top center" },
    );
    const items = menuRef.current.querySelectorAll("[data-opt]");
    gsap.fromTo(
      items,
      { opacity: 0, y: -4 },
      { opacity: 1, y: 0, duration: 0.18, stagger: 0.025, ease: "power2.out", delay: 0.04 },
    );
  }, [open]);

  const choose = (v: string) => {
    onValueChange(v);
    setOpen(false);
  };

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      disabled={disabled}
      onClick={() => (open ? setOpen(false) : openMenu())}
      className={cn(
        "no-drag flex w-full items-center justify-between gap-2 rounded-xl border border-border",
        "bg-surface-2 px-3.5 py-2.5 text-left text-sm text-text outline-none",
        "transition-[box-shadow,border-color] duration-200 cursor-pointer",
        "hover:border-primary/40",
        open && "border-primary/60 shadow-[0_0_0_3px_rgb(var(--primary)/0.18)]",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      <span className={cn("truncate", !selected && "text-muted")}>
        {selected?.label ?? placeholder ?? ""}
      </span>
      <ChevronDown
        className={cn(
          "h-4 w-4 shrink-0 text-muted transition-transform duration-200",
          open && "rotate-180 text-primary",
        )}
      />
    </button>
  );

  return (
    <Field label={label} hint={hint}>
      {trigger}
      {open &&
        rect &&
        createPortal(
          <div
            ref={menuRef}
            className="glass fixed z-[70] max-h-72 overflow-y-auto rounded-xl p-1.5 shadow-card"
            style={{
              left: rect.left,
              top: rect.bottom + 6,
              width: rect.width,
            }}
          >
            {options.map((o) => {
              const active = o.value === value;
              return (
                <button
                  key={o.value}
                  data-opt
                  type="button"
                  onClick={() => choose(o.value)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                    active
                      ? "bg-primary/12 text-primary"
                      : "text-text hover:bg-surface-2",
                  )}
                >
                  <span className="truncate">{o.label}</span>
                  {active && <Check className="h-4 w-4 shrink-0" />}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </Field>
  );
}

import { forwardRef, type ButtonHTMLAttributes } from "react";
import gsap from "gsap";
import { cn } from "@/lib/cn";
import { prefersReducedMotion } from "@/hooks/useGSAPAnim";

type Variant = "primary" | "secondary" | "ghost" | "subtle" | "danger";
type Size = "sm" | "md" | "lg" | "icon";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-primary text-white dark:text-[#04221d] hover:bg-primary-hover shadow-soft",
  secondary: "bg-surface-2 text-text border border-border hover:bg-surface",
  ghost: "text-text hover:bg-surface-2",
  subtle: "bg-primary/10 text-primary hover:bg-primary/20",
  danger: "bg-danger text-white hover:brightness-110 shadow-soft",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-xs rounded-lg gap-1.5",
  md: "h-10 px-4 text-sm rounded-xl gap-2",
  lg: "h-12 px-6 text-base rounded-xl gap-2.5",
  icon: "h-10 w-10 rounded-xl justify-center",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

function spawnRipple(e: React.MouseEvent<HTMLButtonElement>) {
  if (prefersReducedMotion()) return;
  const btn = e.currentTarget;
  const rect = btn.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  const ripple = document.createElement("span");
  ripple.style.cssText = [
    "position:absolute",
    "border-radius:9999px",
    "pointer-events:none",
    "background:currentColor",
    "opacity:0.25",
    `width:${size}px`,
    `height:${size}px`,
    `left:${e.clientX - rect.left - size / 2}px`,
    `top:${e.clientY - rect.top - size / 2}px`,
  ].join(";");
  btn.appendChild(ripple);
  gsap.fromTo(
    ripple,
    { scale: 0, opacity: 0.25 },
    {
      scale: 2.4,
      opacity: 0,
      duration: 0.6,
      ease: "power2.out",
      onComplete: () => ripple.remove(),
    },
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { variant = "primary", size = "md", loading, className, children, onClick, disabled, ...rest },
    ref,
  ) => {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        onClick={(e) => {
          spawnRipple(e);
          onClick?.(e);
        }}
        className={cn(
          "relative overflow-hidden select-none no-drag",
          "inline-flex items-center justify-center font-medium",
          "transition-[background-color,transform,filter] duration-200",
          "active:scale-[0.97] disabled:opacity-50 disabled:pointer-events-none",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
          VARIANTS[variant],
          SIZES[size],
          className,
        )}
        {...rest}
      >
        {loading && (
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent" />
        )}
        {children}
      </button>
    );
  },
);

Button.displayName = "Button";

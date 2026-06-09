import { cn } from "@/lib/cn";

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  id?: string;
}

export function Switch({ checked, onChange, disabled, label, id }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full no-drag",
        "transition-colors duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
        checked ? "bg-primary" : "bg-muted/30",
        disabled && "opacity-50 pointer-events-none",
      )}
    >
      <span
        className={cn(
          "inline-block h-4.5 w-4.5 transform rounded-full bg-white shadow-sm transition-transform duration-300",
          checked ? "translate-x-[22px]" : "translate-x-1",
        )}
        style={{ height: "1.125rem", width: "1.125rem" }}
      />
    </button>
  );
}

import { cn } from "@/lib/cn";
import { useT } from "@/i18n";

export function Spinner({ className }: { className?: string }) {
  const t = useT();
  return (
    <span
      className={cn(
        "inline-block animate-spin rounded-full border-2 border-current border-r-transparent",
        className ?? "h-5 w-5",
      )}
      role="status"
      aria-label={t("a11y.loading")}
    />
  );
}

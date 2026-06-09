import { ShieldCheck, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/cn";
import { useT } from "@/i18n";
import { useAppStore } from "@/store/useAppStore";

/**
 * Live status pill for the always-on local proxy. Green when running, red
 * when the port couldn't be bound (the user needs to pick a different one
 * in Settings → Proxy credentials).
 */
export function ProxyStatusPill() {
  const t = useT();
  const running = useAppStore((s) => s.proxyRunning);
  const port = useAppStore((s) => s.settings.proxyPort);

  return (
    <div
      title={running ? t("proxy.running", { port }) : t("proxy.stopped")}
      aria-live="polite"
      className={cn(
        "no-drag flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-xl border px-3 text-sm",
        running
          ? "border-success/40 bg-success/10 text-success"
          : "border-danger/40 bg-danger/10 text-danger",
      )}
    >
      {running ? (
        <ShieldCheck className="h-4 w-4 shrink-0" />
      ) : (
        <ShieldAlert className="h-4 w-4 shrink-0" />
      )}
      <span className="hidden font-medium md:inline">
        {running ? t("proxy.running", { port }) : t("proxy.stopped")}
      </span>
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          running ? "bg-success" : "bg-danger",
        )}
      />
    </div>
  );
}

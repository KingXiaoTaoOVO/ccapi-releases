import { Zap } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle/ThemeToggle";
import { LanguageToggle } from "@/components/LanguageToggle";
import { ProxyStatusPill } from "@/components/SeamlessToggle";
import { StatusBadge } from "@/components/StatusBadge/StatusBadge";
import { useT } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import { useAppStore } from "@/store/useAppStore";

const TITLE_KEYS: Record<string, { title: MessageKey; subtitle: MessageKey }> = {
  dashboard: { title: "view.dashboard.title", subtitle: "view.dashboard.subtitle" },
  chat: { title: "view.chat.title", subtitle: "view.chat.subtitle" },
  usage: { title: "view.usage.title", subtitle: "view.usage.subtitle" },
  skills: { title: "view.skills.title", subtitle: "view.skills.subtitle" },
  mcp: { title: "view.mcp.title", subtitle: "view.mcp.subtitle" },
  rules: { title: "view.rules.title", subtitle: "view.rules.subtitle" },
  agents: { title: "view.agents.title", subtitle: "view.agents.subtitle" },
  tasks: { title: "view.tasks.title", subtitle: "view.tasks.subtitle" },
  logs: { title: "view.logs.title", subtitle: "view.logs.subtitle" },
  settings: { title: "view.settings.title", subtitle: "view.settings.subtitle" },
};

export function TopBar() {
  const t = useT();
  const view = useAppStore((s) => s.view);
  const activeKey = useAppStore((s) => s.keys.find((k) => k.id === s.activeKeyId));
  const meta = TITLE_KEYS[view] ?? TITLE_KEYS.dashboard;

  return (
    <header className="flex items-center gap-4 border-b border-border bg-surface/40 px-6 py-3.5 backdrop-blur-xl drag-region">
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-lg font-semibold leading-tight">{t(meta.title)}</h1>
        <p className="truncate text-xs text-muted">{t(meta.subtitle)}</p>
      </div>

      <div className="flex shrink-0 items-center gap-3 no-drag">
        {activeKey ? (
          <div className="hidden shrink-0 items-center gap-2 whitespace-nowrap rounded-xl border border-primary/30 bg-primary/5 px-3 py-1.5 md:flex">
            <Zap className="h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="text-xs text-muted">{t("topbar.active")}</span>
            <span className="max-w-[140px] truncate text-sm font-medium">{activeKey.name}</span>
            <StatusBadge status={activeKey.status} size="sm" />
          </div>
        ) : (
          <div className="hidden shrink-0 whitespace-nowrap rounded-xl border border-border bg-surface-2 px-3 py-1.5 text-xs text-muted md:block">
            {t("topbar.noActive")}
          </div>
        )}
        <ProxyStatusPill />
        <LanguageToggle />
        <ThemeToggle />
      </div>
    </header>
  );
}

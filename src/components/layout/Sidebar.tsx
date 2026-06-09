import { useEffect, useState } from "react";
import {
  Bot,
  Boxes,
  ClipboardList,
  FileText,
  Gauge,
  KeyRound,
  LayoutDashboard,
  MessageSquare,
  Package,
  Plug,
  RefreshCcw,
  ScrollText,
  Settings2,
  Sparkles,
  Terminal,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useT } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import { BrandLogo } from "@/components/BrandLogo";
import type { View } from "@/store/useAppStore";
import { useAppStore } from "@/store/useAppStore";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import { useUpdateStore } from "@/store/useUpdateStore";
import { getAppVersion } from "@/services/updater";

interface NavItem {
  view: View;
  labelKey: MessageKey;
  icon: typeof LayoutDashboard;
  /** Reactive badge counter (lengths). 0 hides the badge. */
  count?: number;
}

interface NavGroup {
  labelKey: MessageKey;
  items: NavItem[];
}

export function Sidebar() {
  const t = useT();
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const env = useAppStore((s) => s.claudeEnv);
  const keyCount = useAppStore((s) => s.keys.length);
  const skillCount = useWorkspaceStore((s) => s.skills.length);
  const mcpCount = useWorkspaceStore((s) => s.mcpServers.length);
  const ruleCount = useWorkspaceStore((s) => s.rules.length);
  const agentCount = useWorkspaceStore((s) => s.agents.length);
  const chatCount = useWorkspaceStore((s) => s.chats.length);
  const taskCount = useWorkspaceStore((s) => s.tasks.length);
  const logCount = useWorkspaceStore((s) => s.logs.length);
  const updatePhase = useUpdateStore((s) => s.phase);
  const checkUpdate = useUpdateStore((s) => s.check);
  const openUpdateModal = useUpdateStore((s) => s.openModal);
  const updateAvailable = useUpdateStore((s) => s.info);
  const [appVersion, setAppVersion] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    getAppVersion()
      .then((v) => {
        if (!cancelled) setAppVersion(v);
      })
      .catch(() => {
        /* tauri unavailable (browser dev) — leave blank */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const groups: NavGroup[] = [
    {
      labelKey: "nav.groupWorkspace",
      items: [
        {
          view: "dashboard",
          labelKey: "nav.dashboard",
          icon: KeyRound,
          count: keyCount,
        },
        {
          view: "chat",
          labelKey: "nav.chat",
          icon: MessageSquare,
          count: chatCount,
        },
        {
          view: "usage",
          labelKey: "nav.usage",
          icon: Gauge,
          count: keyCount,
        },
      ],
    },
    {
      labelKey: "nav.groupAgents",
      items: [
        {
          view: "agents",
          labelKey: "nav.agents",
          icon: Bot,
          count: agentCount,
        },
        {
          view: "skills",
          labelKey: "nav.skills",
          icon: Sparkles,
          count: skillCount,
        },
        {
          view: "mcp",
          labelKey: "nav.mcp",
          icon: Plug,
          count: mcpCount,
        },
        {
          view: "rules",
          labelKey: "nav.rules",
          icon: ScrollText,
          count: ruleCount,
        },
        {
          view: "tasks",
          labelKey: "nav.tasks",
          icon: ClipboardList,
          count: taskCount,
        },
      ],
    },
  ];

  const renderItem = ({ view: v, labelKey, icon: Icon, count }: NavItem) => (
    <button
      key={v}
      onClick={() => setView(v)}
      className={cn(
        "no-drag flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
        view === v
          ? "bg-primary/10 text-primary"
          : "text-muted hover:bg-surface-2 hover:text-text",
      )}
    >
      <Icon className="shrink-0" style={{ height: "1.125rem", width: "1.125rem" }} />
      <span className="flex-1 truncate text-left">{t(labelKey)}</span>
      {count !== undefined && count > 0 && (
        <span
          className={cn(
            "shrink-0 rounded-full px-2 text-[11px] tabular-nums",
            view === v ? "bg-primary/20 text-primary" : "bg-surface-2 text-muted",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface/60 backdrop-blur-xl">
      {/* brand */}
      <div className="flex items-center gap-2.5 px-5 py-5 drag-region">
        <BrandLogo size={32} />
        <div>
          <p className="font-display text-base leading-tight">CCAPI</p>
          <p className="text-[11px] leading-tight text-muted">{t("app.tagline")}</p>
        </div>
      </div>

      {/* grouped nav */}
      <nav className="flex-1 overflow-y-auto px-3 py-2">
        {groups.map((g, gi) => (
          <div key={g.labelKey} className={cn(gi > 0 && "mt-4")}>
            <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted/70">
              {t(g.labelKey)}
            </p>
            <div className="space-y-1">{g.items.map(renderItem)}</div>
          </div>
        ))}

        {/* system group pinned at the bottom — logs + settings */}
        <div className="mt-4 border-t border-border/60 pt-3">
          <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted/70">
            {t("nav.groupSystem")}
          </p>
          <div className="space-y-1">
            {renderItem({
              view: "logs",
              labelKey: "nav.logs",
              icon: FileText,
              count: logCount,
            })}
            {renderItem({
              view: "settings",
              labelKey: "nav.settings",
              icon: Settings2,
            })}
          </div>
        </div>
      </nav>

      {/* claude env status */}
      <div className="m-3 rounded-xl border border-border bg-surface-2/60 p-3">
        <div className="flex items-center gap-2 text-xs font-medium">
          <Terminal className="h-3.5 w-3.5 text-muted" />
          Claude Code
          <span
            className={cn(
              "ml-auto h-2 w-2 rounded-full",
              env?.installed ? "bg-success" : "bg-danger",
            )}
          />
        </div>
        <p className="mt-1.5 flex items-center gap-1 text-[11px] text-muted">
          <Boxes className="h-3 w-3" />
          {env?.installed ? env.version || t("sidebar.installed") : t("sidebar.notDetected")}
        </p>
      </div>

      {/* CCAPI version + check-update affordance */}
      <button
        onClick={() =>
          updateAvailable ? openUpdateModal() : checkUpdate({ silent: false })
        }
        className={cn(
          "no-drag mx-3 mb-3 flex items-center gap-2 rounded-xl border border-border bg-surface-2/40 px-3 py-2 text-left",
          "text-[11px] text-muted transition-colors hover:border-primary/40 hover:text-text",
        )}
        title={
          updateAvailable
            ? t("update.foundShort", { version: updateAvailable.version })
            : t("update.checkNow")
        }
      >
        <Package className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="flex-1 truncate font-medium tabular-nums">
          {appVersion ? `v${appVersion}` : t("update.versionUnknown")}
        </span>
        {updatePhase === "checking" ? (
          <RefreshCcw className="h-3 w-3 shrink-0 animate-spin" />
        ) : updateAvailable ? (
          <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
            {t("update.newBadge")}
          </span>
        ) : null}
      </button>
    </aside>
  );
}

import {
  Bot,
  Code2,
  Coins,
  Crown,
  Gauge,
  KeyRound,
  LogOut,
  Mail,
  MessagesSquare,
  Plug,
  ScrollText,
  Shield,
  Sparkles,
  Ticket,
  User as UserIcon,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useT } from "@/i18n";
import { BrandLogo } from "@/components/BrandLogo";
import { LanguageToggle } from "@/components/LanguageToggle";
import { ThemeToggle } from "@/components/ThemeToggle/ThemeToggle";
import { VersionBadge } from "@/components/VersionBadge";
import { useServerInfoStore } from "@/store/useServerInfoStore";
import { useAuthStore } from "@/store/useAuthStore";
import { useClientStore, type ClientView } from "@/store/useClientStore";

interface Item {
  view: ClientView;
  labelKey: string;
  icon: typeof Gauge;
}

interface Group {
  labelKey: string;
  items: Item[];
}

const GROUPS: Group[] = [
  {
    labelKey: "client.nav.group.account",
    items: [
      { view: "dashboard", labelKey: "client.nav.dashboard", icon: Gauge },
      { view: "quota", labelKey: "client.nav.quota", icon: KeyRound },
      { view: "tokens", labelKey: "client.nav.tokens", icon: Code2 },
      { view: "playground", labelKey: "client.nav.playground", icon: MessagesSquare },
    ],
  },
  {
    labelKey: "client.nav.group.workspace",
    items: [
      { view: "chat", labelKey: "client.nav.chat", icon: MessagesSquare },
      { view: "agents", labelKey: "client.nav.agents", icon: Bot },
      { view: "skills", labelKey: "client.nav.skills", icon: Sparkles },
      { view: "mcp", labelKey: "client.nav.mcp", icon: Plug },
      { view: "rules", labelKey: "client.nav.rules", icon: ScrollText },
    ],
  },
  {
    labelKey: "client.nav.group.billing",
    items: [
      { view: "subscription", labelKey: "client.nav.subscription", icon: Crown },
      { view: "recharge", labelKey: "client.nav.recharge", icon: Coins },
      { view: "redeem", labelKey: "client.nav.redeem", icon: Ticket },
      { view: "invite", labelKey: "client.nav.invite", icon: Mail },
    ],
  },
  {
    labelKey: "client.nav.group.system",
    items: [
      { view: "security", labelKey: "client.nav.security", icon: Shield },
      { view: "proxy", labelKey: "client.nav.proxy", icon: Wrench },
      { view: "profile", labelKey: "client.nav.profile", icon: UserIcon },
    ],
  },
];

export function ClientSidebar() {
  const t = useT();
  const view = useClientStore((s) => s.view);
  const setView = useClientStore((s) => s.setView);
  const user = useAuthStore((s) => s.session?.user);
  const logout = useAuthStore((s) => s.logout);
  const serverInfo = useServerInfoStore((s) => s.info);
  const siteName = serverInfo?.site?.name || "CCAPI";
  const siteLogo = serverInfo?.site?.logoUrl || "";

  const has = (perm: string) =>
    !user ||
    user.permissions.includes("*") ||
    user.permissions.includes(perm);

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface/60 backdrop-blur-xl">
      <div className="flex items-center gap-2.5 px-5 py-5 drag-region">
        {siteLogo ? (
          <img src={siteLogo} alt="logo" className="h-8 w-8 rounded-lg object-contain" />
        ) : (
          <BrandLogo size={32} />
        )}
        <div>
          <p className="font-display text-base leading-tight">{siteName}</p>
          <p className="text-[11px] leading-tight text-muted">{t("app.tagline")}</p>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-2">
        {GROUPS.map((g, gi) => (
          <div key={g.labelKey} className={cn(gi > 0 && "mt-3")}>
            <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted/70">
              {t(g.labelKey as any)}
            </p>
            <div className="space-y-1">
              {g.items.map((it) => {
                if (it.view === "redeem" && !has("code.redeem")) return null;
                return (
                  <button
                    key={it.view}
                    onClick={() => setView(it.view)}
                    className={cn(
                      "no-drag flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors",
                      view === it.view
                        ? "bg-primary/10 text-primary"
                        : "text-muted hover:bg-surface-2 hover:text-text",
                    )}
                  >
                    <it.icon className="h-[1.05rem] w-[1.05rem] shrink-0" />
                    <span className="flex-1 truncate text-left">
                      {t(it.labelKey as any)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="m-3 space-y-2 rounded-xl border border-border bg-surface-2/60 p-3">
        <div className="flex items-center gap-2">
          <div className="grid h-7 w-7 place-items-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
            {(user?.username ?? "?").charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium">{user?.username}</p>
            <p className="text-[10px] text-muted">{user?.role}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <ThemeToggle />
          <LanguageToggle />
        </div>
        <VersionBadge />
        <button
          onClick={() => void logout()}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-surface/50 px-2 py-1.5 text-[11px] text-muted transition-colors hover:border-danger/40 hover:text-danger"
        >
          <LogOut className="h-3 w-3" />
          {t("admin.logout")}
        </button>
      </div>
    </aside>
  );
}

import {
  Boxes,
  Building2,
  Code2,
  Coins,
  Crown,
  CreditCard,
  Filter,
  Gauge,
  Layers,
  Link2,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Mail,
  Network,
  Server as ServerIcon,
  Settings2,
  ShieldCheck,
  Ticket,
  Trophy,
  Users,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useT } from "@/i18n";
import { BrandLogo } from "@/components/BrandLogo";
import { LanguageToggle } from "@/components/LanguageToggle";
import { ThemeToggle } from "@/components/ThemeToggle/ThemeToggle";
import { VersionBadge } from "@/components/VersionBadge";
import { useAuthStore } from "@/store/useAuthStore";
import {
  useServerStore,
  type AdminView,
} from "@/store/useServerStore";

interface Item {
  view: AdminView;
  labelKey: string;
  icon: typeof LayoutDashboard;
  permission?: string;
}

interface Group {
  labelKey: string;
  items: Item[];
}

export function AdminSidebar() {
  const t = useT();
  const view = useServerStore((s) => s.view);
  const setView = useServerStore((s) => s.setView);
  const user = useAuthStore((s) => s.session?.user);
  const logout = useAuthStore((s) => s.logout);

  const has = (perm?: string) =>
    !perm || !user
      ? true
      : user.permissions.includes("*") || user.permissions.includes(perm);

  const groups: Group[] = [
    {
      labelKey: "admin.nav.overview",
      items: [
        {
          view: "dashboard",
          labelKey: "admin.nav.dashboard",
          icon: LayoutDashboard,
        },
      ],
    },
    {
      labelKey: "admin.nav.tenants",
      items: [
        {
          view: "users",
          labelKey: "admin.nav.users",
          icon: Users,
          permission: "user.read",
        },
        {
          view: "roles",
          labelKey: "admin.nav.roles",
          icon: ShieldCheck,
          permission: "role.read",
        },
      ],
    },
    {
      labelKey: "admin.nav.billing",
      items: [
        {
          view: "codes",
          labelKey: "admin.nav.codes",
          icon: Ticket,
          permission: "code.read",
        },
        {
          view: "tiers",
          labelKey: "admin.nav.tiers",
          icon: Trophy,
          permission: "tier.read",
        },
        {
          view: "invitations",
          labelKey: "admin.nav.invites",
          icon: Mail,
          permission: "invite.read.all",
        },
      ],
    },
    {
      labelKey: "admin.nav.monitor",
      items: [
        {
          view: "usage",
          labelKey: "admin.nav.usage",
          icon: KeyRound,
          permission: "usage.read.all",
        },
        {
          view: "channels",
          labelKey: "admin.nav.channels",
          icon: Network,
          permission: "channel.read",
        },
        {
          view: "models",
          labelKey: "admin.nav.models",
          icon: Coins,
          permission: "model.read",
        },
        {
          view: "userGroups",
          labelKey: "admin.nav.userGroups",
          icon: Boxes,
          permission: "user_group.read",
        },
        {
          view: "tokens",
          labelKey: "admin.nav.tokens",
          icon: Code2,
          permission: "token.read.all",
        },
      ],
    },
  ];

  const renderItem = (it: Item) => {
    if (!has(it.permission)) return null;
    return (
      <button
        key={it.view}
        onClick={() => setView(it.view)}
        className={cn(
          "no-drag flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
          view === it.view
            ? "bg-primary/10 text-primary"
            : "text-muted hover:bg-surface-2 hover:text-text",
        )}
      >
        <it.icon className="h-[1.125rem] w-[1.125rem] shrink-0" />
        <span className="flex-1 truncate text-left">{t(it.labelKey as any)}</span>
      </button>
    );
  };

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface/60 backdrop-blur-xl">
      {/* brand */}
      <div className="flex items-center gap-2.5 px-5 py-5 drag-region">
        <BrandLogo size={32} />
        <div>
          <p className="font-display text-base leading-tight">CCAPI</p>
          <p className="text-[11px] leading-tight text-primary">
            {t("admin.brand.label")}
          </p>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-2">
        {groups.map((g, gi) => (
          <div key={g.labelKey} className={cn(gi > 0 && "mt-4")}>
            <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted/70">
              {t(g.labelKey as any)}
            </p>
            <div className="space-y-1">{g.items.map(renderItem)}</div>
          </div>
        ))}

        {/* 系统组 */}
        <div className="mt-4 border-t border-border/60 pt-3">
          <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted/70">
            {t("admin.nav.system")}
          </p>
          <div className="space-y-1">
            {renderItem({
              view: "audit",
              labelKey: "admin.nav.audit",
              icon: ShieldCheck,
              permission: "audit.read",
            })}
            {renderItem({
              view: "serverConfig",
              labelKey: "admin.nav.serverConfig",
              icon: ServerIcon,
              permission: "config.read",
            })}
            {renderItem({
              view: "settings",
              labelKey: "admin.nav.settings",
              icon: Settings2,
            })}
          </div>
        </div>

        {/* 第 2 波：Admin 配置组（所有 admin/root 均可见，权限再细化由后端守门） */}
        <div className="mt-4 border-t border-border/60 pt-3">
          <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted/70">
            {t("admin.nav.policies")}
          </p>
          <div className="space-y-1">
            {renderItem({
              view: "rateLimits",
              labelKey: "admin.nav.rateLimits",
              icon: Gauge,
              permission: "config.read",
            })}
            {renderItem({
              view: "words",
              labelKey: "admin.nav.words",
              icon: Filter,
              permission: "config.read",
            })}
            {renderItem({
              view: "orders",
              labelKey: "admin.nav.orders",
              icon: Coins,
              permission: "config.read",
            })}
            {renderItem({
              view: "asyncTasks",
              labelKey: "admin.nav.tasks",
              icon: ListChecks,
              permission: "config.read",
            })}
            {renderItem({
              view: "mail",
              labelKey: "admin.nav.mail",
              icon: Mail,
              permission: "config.read",
            })}
            {renderItem({
              view: "orgs",
              labelKey: "admin.nav.orgs",
              icon: Building2,
              permission: "config.read",
            })}
            {renderItem({
              view: "prefill",
              labelKey: "admin.nav.prefill",
              icon: Layers,
              permission: "config.read",
            })}
          </div>
        </div>

        {/* Root 专属：站点 / 邮件 / 支付 / OAuth */}
        {user?.role === "root" && (
          <div className="mt-4 border-t border-warning/30 pt-3">
            <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-warning/80">
              {t("admin.nav.rootZone")}
            </p>
            <div className="space-y-1">
              {renderItem({
                view: "site",
                labelKey: "admin.nav.site",
                icon: Crown,
              })}
              {renderItem({
                view: "mail",
                labelKey: "admin.nav.mail",
                icon: Mail,
              })}
              {renderItem({
                view: "payment",
                labelKey: "admin.nav.payment",
                icon: CreditCard,
              })}
              {renderItem({
                view: "oauth",
                labelKey: "admin.nav.oauth",
                icon: Link2,
              })}
              {renderItem({
                view: "sysAdvanced",
                labelKey: "admin.nav.sysAdvanced",
                icon: Settings2,
              })}
            </div>
          </div>
        )}
      </nav>

      {/* 用户卡片 + 主题/语言切换 + 登出 */}
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

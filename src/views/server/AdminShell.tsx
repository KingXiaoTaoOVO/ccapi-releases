import { AdminSidebar } from "@/components/layout/AdminSidebar";
import { useServerStore } from "@/store/useServerStore";
import { AdminDashboard } from "./AdminDashboard";
import { UserManager } from "./UserManager";
import { RoleManager } from "./RoleManager";
import { UsageMonitor } from "./UsageMonitor";
import { ServerConfig } from "./ServerConfig";
import { ActivationCodes } from "./ActivationCodes";
import { TierManager } from "./TierManager";
import { Invitations } from "./Invitations";
import { ChannelManager } from "./ChannelManager";
import { ModelManager } from "./ModelManager";
import { UserGroupManager } from "./UserGroupManager";
import { AdminTokens } from "./AdminTokens";
import { AuditLog } from "./AuditLog";
import { SiteConfig } from "./SiteConfig";
import { MailSetting } from "./MailSetting";
import { PaymentConfig } from "./PaymentConfig";
import { OAuthProviders } from "./OAuthProviders";
import { SensitiveWords } from "./SensitiveWords";
import { RateLimits } from "./RateLimits";
import { RechargeOrders } from "./RechargeOrders";
import { AsyncTasks } from "./AsyncTasks";
import { SystemAdvanced } from "./SystemAdvanced";
import { OrgManager } from "./OrgManager";
import { PrefillManager } from "./PrefillManager";
import { PreferencesPanel } from "@/components/PreferencesPanel/PreferencesPanel";
import { useEntrance } from "@/hooks/useGSAPAnim";

function AdminPreferences() {
  const ref = useEntrance<HTMLDivElement>({ y: 12 });
  return (
    <div ref={ref} className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-3xl">
        <PreferencesPanel />
      </div>
    </div>
  );
}

export function AdminShell() {
  const view = useServerStore((s) => s.view);

  let content: React.ReactNode;
  switch (view) {
    case "dashboard":
      content = <AdminDashboard />;
      break;
    case "users":
      content = <UserManager />;
      break;
    case "roles":
      content = <RoleManager />;
      break;
    case "usage":
      content = <UsageMonitor />;
      break;
    case "serverConfig":
      content = <ServerConfig />;
      break;
    case "codes":
      content = <ActivationCodes />;
      break;
    case "tiers":
      content = <TierManager />;
      break;
    case "invitations":
      content = <Invitations />;
      break;
    case "channels":
      content = <ChannelManager />;
      break;
    case "models":
      content = <ModelManager />;
      break;
    case "userGroups":
      content = <UserGroupManager />;
      break;
    case "tokens":
      content = <AdminTokens />;
      break;
    case "audit":
      content = <AuditLog />;
      break;
    case "settings":
      content = <AdminPreferences />;
      break;
    case "site":
      content = <SiteConfig />;
      break;
    case "mail":
      content = <MailSetting />;
      break;
    case "payment":
      content = <PaymentConfig />;
      break;
    case "oauth":
      content = <OAuthProviders />;
      break;
    case "words":
      content = <SensitiveWords />;
      break;
    case "rateLimits":
      content = <RateLimits />;
      break;
    case "orders":
      content = <RechargeOrders />;
      break;
    case "asyncTasks":
      content = <AsyncTasks />;
      break;
    case "sysAdvanced":
      content = <SystemAdvanced />;
      break;
    case "orgs":
      content = <OrgManager />;
      break;
    case "prefill":
      content = <PrefillManager />;
      break;
  }

  return (
    <div className="flex h-full">
      <AdminSidebar />
      <main className="min-h-0 flex-1 overflow-hidden">{content}</main>
    </div>
  );
}

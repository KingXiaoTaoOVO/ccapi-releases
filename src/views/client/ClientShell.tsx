import { ClientSidebar } from "@/components/layout/ClientSidebar";
import { useClientStore } from "@/store/useClientStore";
import { ClientDashboard } from "./ClientDashboard";
import { QuotaLog } from "./QuotaLog";
import { Redeem } from "./Redeem";
import { Invite } from "./Invite";
import { Profile } from "./Profile";
import { Tokens } from "./Tokens";
import { Playground } from "./Playground";
import { Security } from "./Security";
import { Recharge } from "./Recharge";
import { Subscription } from "./Subscription";
import { Dashboard } from "@/views/Dashboard";
import { Chat } from "@/views/Chat";
import { Agents } from "@/views/Agents";
import { Skills } from "@/views/Skills";
import { McpServers } from "@/views/McpServers";
import { Rules } from "@/views/Rules";

export function ClientShell() {
  const view = useClientStore((s) => s.view);

  let content: React.ReactNode;
  switch (view) {
    case "dashboard":
      content = <ClientDashboard />;
      break;
    case "quota":
      content = <QuotaLog />;
      break;
    case "redeem":
      content = <Redeem />;
      break;
    case "invite":
      content = <Invite />;
      break;
    case "profile":
      content = <Profile />;
      break;
    case "tokens":
      content = <Tokens />;
      break;
    case "playground":
      content = <Playground />;
      break;
    case "proxy":
      // 复用原 CCAPI 的本地 API key 池 / 代理 UI
      content = <Dashboard />;
      break;
    case "security":
      content = <Security />;
      break;
    case "recharge":
      content = <Recharge />;
      break;
    case "subscription":
      content = <Subscription />;
      break;
    case "chat":
      content = <Chat />;
      break;
    case "agents":
      content = <Agents />;
      break;
    case "skills":
      content = <Skills />;
      break;
    case "mcp":
      content = <McpServers />;
      break;
    case "rules":
      content = <Rules />;
      break;
  }

  return (
    <div className="flex h-full">
      <ClientSidebar />
      <main className="min-h-0 flex-1 overflow-hidden">{content}</main>
    </div>
  );
}

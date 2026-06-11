import { useEffect, useState } from "react";
import { AuroraBackground } from "@/components/layout/AuroraBackground";
import { Dashboard } from "@/views/Dashboard";
import { Settings } from "@/views/Settings";
import { Chat } from "@/views/Chat";
import { Skills } from "@/views/Skills";
import { McpServers } from "@/views/McpServers";
import { Rules } from "@/views/Rules";
import { Agents } from "@/views/Agents";
import { Tasks } from "@/views/Tasks";
import { Usage } from "@/views/Usage";
import { Logs } from "@/views/Logs";
import { ToastContainer } from "@/components/Toast/ToastContainer";
import { ConfirmHost } from "@/components/ConfirmHost";
import { PromptHost } from "@/components/PromptHost";
import { ReconnectOverlay } from "@/components/ReconnectOverlay";
import { ContextMenuProvider } from "@/components/ui/ContextMenu";
import { useReconnectStore } from "@/store/useReconnectStore";
import { UpdateModal } from "@/components/UpdateModal/UpdateModal";
import { Spinner } from "@/components/ui/Spinner";
import { useT } from "@/i18n";
import { onTrayAction } from "@/services/tauri";
import {
  adminServerStatus,
} from "@/services/tauri";
import { configureApiClient } from "@/services/apiClient";
import type { View } from "@/store/useAppStore";
import { useAppStore } from "@/store/useAppStore";
import { useAuthStore } from "@/store/useAuthStore";
import { useClientStore } from "@/store/useClientStore";
import { useModeStore } from "@/store/useModeStore";
import { syncServerInfo, useServerInfoStore } from "@/store/useServerInfoStore";
import { useServerStore } from "@/store/useServerStore";
import { useThemeStore } from "@/store/useThemeStore";
import { useUpdateStore } from "@/store/useUpdateStore";
import { ModeSelect } from "@/views/auth/ModeSelect";
import { ServerEntry } from "@/views/auth/ServerEntry";
import { ServerInit } from "@/views/auth/ServerInit";
import { ServerUrlSetup } from "@/views/auth/ServerUrlSetup";
import { Login } from "@/views/auth/Login";
import { Register } from "@/views/auth/Register";
import { ForgotPassword } from "@/views/auth/ForgotPassword";
import { ChangePassword } from "@/views/auth/ChangePassword";
import { AdminShell } from "@/views/server/AdminShell";
import { ClientShell as ClientServerShell } from "@/views/client/ClientShell";
import { AuthChrome } from "@/components/layout/AuthChrome";

function BrandLoader({ label }: { label: string }) {
  return (
    <div className="grid h-full place-items-center">
      <div className="flex flex-col items-center gap-4">
        <div className="grid h-14 w-14 place-items-center rounded-2xl border border-border bg-surface shadow-glow">
          <Spinner className="h-6 w-6 text-primary" />
        </div>
        <p className="text-sm text-muted">{label}</p>
      </div>
    </div>
  );
}

// VIEWS map is now unused at top level (the legacy CCAPI views are reachable
// via client/ClientShell's "proxy" tab, which renders Dashboard directly).
// Keep the type to satisfy other modules.
const _UNUSED_VIEWS: Record<View, React.ComponentType> = {
  dashboard: Dashboard,
  chat: Chat,
  usage: Usage,
  skills: Skills,
  mcp: McpServers,
  rules: Rules,
  agents: Agents,
  tasks: Tasks,
  logs: Logs,
  settings: Settings,
};
void _UNUSED_VIEWS;

function App() {
  const t = useT();
  const init = useAppStore((s) => s.init);
  const persist = useAppStore((s) => s.persist);

  const modeReady = useModeStore((s) => s.ready);
  const initMode = useModeStore((s) => s.init);
  const mode = useModeStore((s) => s.mode);
  const serverUrl = useModeStore((s) => s.serverUrl);
  const remoteOk = useModeStore((s) => s.remoteOk);

  // 每当 serverUrl / remoteOk 变化（用户切换连的服务端、ServerInit 完成等），
  // 自动拉取该服务端的 site_info → 让 UI（侧栏品牌、忘记密码入口、OAuth 按钮、
  // VersionBadge 检查更新 repo 等）自动适配
  useEffect(() => {
    if (remoteOk === true && serverUrl) {
      syncServerInfo(serverUrl);
    } else if (!serverUrl) {
      useServerInfoStore.getState().clear();
    }
  }, [serverUrl, remoteOk]);

  const hydrateAuth = useAuthStore((s) => s.hydrate);
  const session = useAuthStore((s) => s.session);

  const [entryPassed, setEntryPassed] = useState(false);
  const [serverBound, setServerBound] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<"login" | "register" | "forgot">("login");

  // 启动期初始化
  useEffect(() => {
    useThemeStore.getState().initSystemWatch();
    void initMode();
    hydrateAuth();
    init();
    const unsub = useThemeStore.subscribe(() => persist());
    return () => unsub();
  }, [init, persist, initMode, hydrateAuth]);

  // 服务端模式：仅同步当前服务端的运行状态，绝不自动启动。
  // 启动由用户在 ServerInit 页面手动点击「启动服务端」触发，避免破坏「不自动
  // 做任何事」的原则，并让用户随时能进入 ServerInit 重置数据库 / 改 IP/端口。
  useEffect(() => {
    if (mode !== "server" || !entryPassed) return;
    void (async () => {
      try {
        const s = await adminServerStatus();
        if (s.running && s.boundAddress) {
          const url = `http://${s.boundAddress}`;
          configureApiClient({ baseUrl: url });
          setServerBound(url);
        }
      } catch (e) {
        console.warn(e);
      }
    })();
  }, [mode, entryPassed]);

  // 客户端模式登录后启动心跳；登出/切回服务端模式时停止。
  useEffect(() => {
    if (mode === "client" && session && !session.user.mustChangePassword) {
      useReconnectStore.getState().start();
      return () => {
        useReconnectStore.getState().stop();
      };
    }
    return undefined;
  }, [mode, session]);

  // 后台升级检查
  useEffect(() => {
    if (mode !== "client" || !session) return;
    const { autoCheckUpdate, autoInstallUpdate } = useAppStore.getState().settings;
    if (!autoCheckUpdate) return;
    const timer = window.setTimeout(() => {
      void useUpdateStore
        .getState()
        .check({ silent: true })
        .then(() => {
          if (autoInstallUpdate && useUpdateStore.getState().phase === "available") {
            void useUpdateStore.getState().startInstall();
          }
        });
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [mode, session]);

  // 系统托盘 -> 视图：按当前登录身份分发到对应的 shell。
  // - admin (scope=server) 的 nav 走 useServerStore；
  // - client (scope=client) 的 nav 走 useClientStore；
  // - 未登录走 useAppStore（legacy）；
  // - rotate / checkAll 只在 client 身份下有意义（本地代理密钥池）。
  useEffect(() => {
    const un = onTrayAction((action) => {
      const sess = useAuthStore.getState().session;
      const activated = !!sess && !sess.user.mustChangePassword;
      const scope = activated ? sess!.scope : null;

      switch (action) {
        case "nav:dashboard":
          if (scope === "server") useServerStore.getState().setView("dashboard");
          else if (scope === "client") useClientStore.getState().setView("dashboard");
          else useAppStore.getState().setView("dashboard");
          break;
        case "nav:settings":
          if (scope === "server") useServerStore.getState().setView("serverConfig");
          else if (scope === "client") useClientStore.getState().setView("profile");
          else useAppStore.getState().setView("settings");
          break;
        case "rotate":
          if (scope === "client") {
            useAppStore.getState().rotateNext(t("dash.rotateManual"));
          }
          break;
        case "checkAll":
          if (scope === "client") {
            useAppStore.getState().checkAll();
          }
          break;
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, [t]);

  let content: React.ReactNode;
  let needsAuthChrome = true;

  if (!modeReady) {
    content = <BrandLoader label={t("loading.config")} />;
  } else if (!mode) {
    content = <ModeSelect />;
  } else if (mode === "server") {
    if (!entryPassed) {
      content = <ServerEntry onPass={() => setEntryPassed(true)} />;
    } else if (!serverBound) {
      content = (
        <ServerInit
          onReady={(url) => {
            setServerBound(url);
            configureApiClient({ baseUrl: url });
          }}
        />
      );
    } else if (!session) {
      content = <Login scope="server" />;
    } else if (session.user.mustChangePassword) {
      content = <ChangePassword />;
    } else {
      content = <AdminShell />;
      needsAuthChrome = false;
    }
  } else {
    // client 模式
    if (!serverUrl || remoteOk !== true) {
      content = <ServerUrlSetup onConnected={() => void 0} />;
    } else if (!session) {
      content =
        authMode === "register" ? (
          <Register onSwitchToLogin={() => setAuthMode("login")} />
        ) : authMode === "forgot" ? (
          <ForgotPassword onBack={() => setAuthMode("login")} />
        ) : (
          <Login
            scope="client"
            onSwitchToRegister={() => setAuthMode("register")}
            onForgotPassword={() => setAuthMode("forgot")}
          />
        );
    } else if (session.user.mustChangePassword) {
      content = <ChangePassword />;
    } else {
      content = <ClientServerShell />;
      needsAuthChrome = false;
    }
  }

  return (
    <ContextMenuProvider>
      <div className="relative h-screen w-screen overflow-hidden bg-bg text-text theme-aware">
        <AuroraBackground />
        <div className="relative z-10 h-full">{content}</div>
        {needsAuthChrome && <AuthChrome />}
        <UpdateModal />
        <ToastContainer />
        <ConfirmHost />
        <PromptHost />
        <ReconnectOverlay />
      </div>
    </ContextMenuProvider>
  );
}

export default App;

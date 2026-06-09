import { useEffect } from "react";
import { AuroraBackground } from "@/components/layout/AuroraBackground";
import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";
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
import { InstallGuide } from "@/components/InstallGuide/InstallGuide";
import { Onboarding } from "@/components/Onboarding/Onboarding";
import { ToastContainer } from "@/components/Toast/ToastContainer";
import { UpdateModal } from "@/components/UpdateModal/UpdateModal";
import { Spinner } from "@/components/ui/Spinner";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { onTrayAction } from "@/services/tauri";
import type { View } from "@/store/useAppStore";
import { useAppStore } from "@/store/useAppStore";
import { useThemeStore } from "@/store/useThemeStore";
import { useUpdateStore } from "@/store/useUpdateStore";

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

const VIEWS: Record<View, React.ComponentType> = {
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

/** Re-mounts (and re-animates) whenever the active view changes. */
function AnimatedView({ view }: { view: View }) {
  const ref = useEntrance<HTMLDivElement>({ y: 12 });
  const ViewComponent = VIEWS[view];
  return (
    <div ref={ref} className="h-full">
      <ViewComponent />
    </div>
  );
}

function App() {
  const t = useT();
  const ready = useAppStore((s) => s.ready);
  const init = useAppStore((s) => s.init);
  const view = useAppStore((s) => s.view);
  const env = useAppStore((s) => s.claudeEnv);
  const onboarded = useAppStore((s) => s.settings.onboarded);
  const persist = useAppStore((s) => s.persist);

  // Boot the app once.
  useEffect(() => {
    useThemeStore.getState().initSystemWatch();
    init();
    // Persist whenever the theme preference changes.
    const unsub = useThemeStore.subscribe(() => persist());
    return () => unsub();
  }, [init, persist]);

  // Background updater check after the app finishes booting. Runs at most
  // once per process and only when the user opted in via Settings.
  useEffect(() => {
    if (!ready) return;
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
  }, [ready]);

  // Bridge system-tray quick actions to the store.
  useEffect(() => {
    const un = onTrayAction((action) => {
      const s = useAppStore.getState();
      switch (action) {
        case "nav:dashboard":
          s.setView("dashboard");
          break;
        case "nav:settings":
          s.setView("settings");
          break;
        case "rotate":
          s.rotateNext(t("dash.rotateManual"));
          break;
        case "checkAll":
          s.checkAll();
          break;
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, [t]);

  let content: React.ReactNode;
  if (!ready || env === null) {
    content = (
      <BrandLoader label={!ready ? t("loading.config") : t("loading.env")} />
    );
  } else if (!env.installed) {
    content = <InstallGuide />;
  } else if (!onboarded) {
    content = <Onboarding />;
  } else {
    content = (
      <div className="flex h-full">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          <main className="min-h-0 flex-1">
            <AnimatedView view={view} />
          </main>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-bg text-text theme-aware">
      <AuroraBackground />
      <div className="relative z-10 h-full">{content}</div>
      <UpdateModal />
      <ToastContainer />
    </div>
  );
}

export default App;

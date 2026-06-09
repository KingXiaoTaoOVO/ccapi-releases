import { useState } from "react";
import { FolderCheck, Monitor, Moon, Rocket, Sun } from "lucide-react";
import type { RotationStrategy, Theme } from "@/types";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import { useAppStore } from "@/store/useAppStore";
import { useThemeStore } from "@/store/useThemeStore";

const THEME_CHOICES: { value: Theme; labelKey: MessageKey; icon: typeof Sun }[] = [
  { value: "light", labelKey: "theme.light", icon: Sun },
  { value: "dark", labelKey: "theme.dark", icon: Moon },
  { value: "system", labelKey: "theme.system", icon: Monitor },
];

export function Onboarding() {
  const t = useT();
  const env = useAppStore((s) => s.claudeEnv);
  const settings = useAppStore((s) => s.settings);
  const completeOnboarding = useAppStore((s) => s.completeOnboarding);
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  const [timeoutSec, setTimeoutSec] = useState(
    Math.round(settings.requestTimeoutMs / 1000),
  );
  const [threshold, setThreshold] = useState(settings.quotaWarnThreshold);
  const [strategy, setStrategy] = useState<RotationStrategy>(settings.rotationStrategy);
  const [autoRotate, setAutoRotate] = useState(settings.autoRotate);

  const cardRef = useEntrance<HTMLDivElement>();

  const finish = () => {
    completeOnboarding({
      requestTimeoutMs: Math.max(3, timeoutSec) * 1000,
      quotaWarnThreshold: Math.min(100, Math.max(0, threshold)),
      rotationStrategy: strategy,
      autoRotate,
    });
  };

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-6">
      <div ref={cardRef} className="card gradient-border my-auto w-full max-w-2xl p-8">
        <div className="flex items-center gap-3">
          <div className="grid h-12 w-12 place-items-center rounded-xl bg-primary/15 text-primary">
            <Rocket className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold">
              {t("onboard.welcome")} <span className="text-gradient">CCAPI</span>
            </h1>
            <p className="text-sm text-muted">{t("onboard.subtitle")}</p>
          </div>
        </div>

        {/* config path */}
        <section className="mt-6 rounded-xl border border-border bg-surface-2/50 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <FolderCheck className="h-4 w-4 text-success" />
            {t("onboard.configFile")}
          </div>
          <p className="mt-1 break-all font-mono text-xs text-muted">
            {env?.settingsPath || "~/.claude/settings.json"}
          </p>
          <p className="mt-1 text-xs text-muted">
            {env?.settingsExists ? t("onboard.configDetected") : t("onboard.configWillCreate")}
          </p>
        </section>

        {/* theme */}
        <section className="mt-5">
          <p className="mb-2 text-sm font-medium">{t("onboard.defaultTheme")}</p>
          <div className="grid grid-cols-3 gap-2">
            {THEME_CHOICES.map((c) => {
              const Icon = c.icon;
              return (
                <button
                  key={c.value}
                  onClick={() => setTheme(c.value)}
                  className={cn(
                    "flex flex-col items-center gap-1.5 rounded-xl border py-3 transition-all",
                    theme === c.value
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-surface-2 text-muted hover:text-text",
                  )}
                >
                  <Icon className="h-5 w-5" />
                  <span className="text-xs">{t(c.labelKey)}</span>
                </button>
              );
            })}
          </div>
        </section>

        {/* params */}
        <section className="mt-5 grid grid-cols-2 gap-4">
          <TextField
            label={t("onboard.timeout")}
            type="number"
            min={3}
            value={timeoutSec}
            onChange={(e) => setTimeoutSec(Number(e.target.value))}
          />
          <TextField
            label={t("onboard.threshold")}
            type="number"
            min={0}
            max={100}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
          />
          <Select
            label={t("onboard.strategy")}
            value={strategy}
            onValueChange={(v) => setStrategy(v as RotationStrategy)}
            options={[
              { value: "sequential", label: t("strategy.sequential") },
              { value: "quota", label: t("strategy.quota") },
              { value: "latency", label: t("strategy.latency") },
            ]}
          />
          <div className="flex items-end pb-1">
            <div className="flex w-full items-center justify-between rounded-xl border border-border bg-surface-2 px-3.5 py-2.5">
              <span className="text-sm">{t("onboard.autoRotate")}</span>
              <Switch checked={autoRotate} onChange={setAutoRotate} />
            </div>
          </div>
        </section>

        <Button className="mt-7 w-full" size="lg" onClick={finish}>
          {t("onboard.finish")}
        </Button>
      </div>
    </div>
  );
}

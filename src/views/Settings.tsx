import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Activity,
  ArrowUpCircle,
  BellRing,
  Check,
  Copy,
  DatabaseBackup,
  Eye,
  EyeOff,
  FileCog,
  Gauge,
  HardDriveDownload,
  Power,
  RotateCw,
  ServerCog,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { AuthField, RotationStrategy } from "@/types";
import { maskKey, formatDateTime } from "@/lib/format";
import { AUTH_FIELD_OPTIONS, DEFAULT_PROXY_PORT } from "@/lib/defaults";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { useConfigFile } from "@/hooks/useConfigFile";
import { useT } from "@/i18n";
import { checkPortAvailable, notifySystem } from "@/services/tauri";
import { useAppStore } from "@/store/useAppStore";
import { useUpdateStore } from "@/store/useUpdateStore";
import { toast } from "@/store/useToastStore";
import { getAppVersion, isAutostart, setAutostart } from "@/services/updater";

function Section({
  icon: Icon,
  title,
  desc,
  children,
}: {
  icon: typeof Gauge;
  title: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className="glass-soft spotlight p-5"
      data-anim
      onMouseMove={(e) => {
        const el = e.currentTarget;
        const r = el.getBoundingClientRect();
        el.style.setProperty("--mx", `${e.clientX - r.left}px`);
        el.style.setProperty("--my", `${e.clientY - r.top}px`);
      }}
    >
      <div className="mb-4 flex items-center gap-2.5">
        <div className="grid h-9 w-9 place-items-center rounded-lg bg-primary/10 text-primary">
          <Icon className="h-4.5 w-4.5" style={{ height: "1.125rem", width: "1.125rem" }} />
        </div>
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          {desc && <p className="text-xs text-muted">{desc}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <span className="text-sm">{label}</span>
      {children}
    </div>
  );
}

/** Drives the "click twice to confirm" pattern used by destructive actions. */
function useConfirm(timeoutMs = 3000) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const arm = () => {
    if (timer.current) clearTimeout(timer.current);
    setArmed(true);
    timer.current = setTimeout(() => setArmed(false), timeoutMs);
  };
  const disarm = () => {
    if (timer.current) clearTimeout(timer.current);
    setArmed(false);
  };
  useEffect(() => () => disarm(), []);
  return { armed, arm, disarm };
}

function ProxyCredentials() {
  const t = useT();
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const restartProxy = useAppStore((s) => s.restartProxy);
  const regenerateProxyKey = useAppStore((s) => s.regenerateProxyKey);
  const proxyRunning = useAppStore((s) => s.proxyRunning);

  const [draftPort, setDraftPort] = useState(settings.proxyPort);
  const [draftKey, setDraftKey] = useState(settings.proxyKey);
  const [reveal, setReveal] = useState(false);
  const [portStatus, setPortStatus] = useState<"unknown" | "free" | "busy">("unknown");
  const [copied, setCopied] = useState(false);
  const regen = useConfirm();

  useEffect(() => setDraftPort(settings.proxyPort), [settings.proxyPort]);
  useEffect(() => setDraftKey(settings.proxyKey), [settings.proxyKey]);

  const portDirty = draftPort !== settings.proxyPort;
  const keyDirty = draftKey !== settings.proxyKey && draftKey.trim().length > 0;

  const onCheckPort = async () => {
    setPortStatus("unknown");
    try {
      // The proxy itself is already listening on the current port, so checking
      // "is it free?" against that same port would always come back "busy". Skip
      // the check when the user hasn't changed the value yet.
      const target = draftPort;
      const free = target === settings.proxyPort && proxyRunning
        ? true
        : await checkPortAvailable(target);
      setPortStatus(free ? "free" : "busy");
    } catch (e) {
      console.error(e);
      setPortStatus("busy");
    }
  };

  const onApplyPort = async () => {
    if (!portDirty) return;
    await restartProxy(draftPort);
    setPortStatus("unknown");
  };

  const onSaveKey = () => {
    if (!keyDirty) return;
    updateSettings({ proxyKey: draftKey.trim() });
    regen.disarm();
  };

  const onRegenerate = async () => {
    if (!regen.armed) {
      regen.arm();
      return;
    }
    regen.disarm();
    await regenerateProxyKey();
  };

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(settings.proxyKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error(e);
    }
  };

  const dotColor =
    portStatus === "free"
      ? "bg-success"
      : portStatus === "busy"
        ? "bg-danger"
        : "bg-muted/50";

  return (
    <Section
      icon={ShieldCheck}
      title={t("set.proxyCredTitle")}
      desc={t("set.proxyCredDesc")}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
        <TextField
          label={t("set.proxyPort")}
          type="number"
          min={1024}
          max={65535}
          value={draftPort}
          onChange={(e) =>
            setDraftPort(Math.min(65535, Math.max(1024, Number(e.target.value) || DEFAULT_PROXY_PORT)))
          }
        />
        <div className="flex items-center gap-2 pb-0.5">
          <Button variant="secondary" size="sm" onClick={onCheckPort}>
            <span className={`mr-1 inline-block h-2 w-2 rounded-full ${dotColor}`} />
            {t("set.portCheck")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!portDirty}
            onClick={onApplyPort}
          >
            {t("set.applyPort")}
          </Button>
        </div>
        {portStatus !== "unknown" && (
          <p
            className={`col-span-full -mt-2 text-xs ${
              portStatus === "free" ? "text-success" : "text-danger"
            }`}
          >
            {portStatus === "free" ? t("set.portFree") : t("set.portBusy")}
          </p>
        )}
      </div>

      <div className="mt-4 space-y-2">
        <span className="block text-xs font-medium text-muted">
          {t("set.proxyKey")}
        </span>
        <div className="flex items-stretch gap-2">
          <input
            className="w-full rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 font-mono text-xs outline-none focus:border-primary/60"
            type={reveal ? "text" : "password"}
            value={draftKey}
            onChange={(e) => setDraftKey(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          <Button
            variant="ghost"
            size="icon"
            title={reveal ? t("set.hide") : t("set.reveal")}
            onClick={() => setReveal((v) => !v)}
          >
            {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
          <Button variant="ghost" size="icon" title={t("set.copy")} onClick={onCopy}>
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            size="sm"
            disabled={!keyDirty}
            onClick={onSaveKey}
          >
            {t("common.save")}
          </Button>
          <Button
            variant={regen.armed ? "danger" : "secondary"}
            size="sm"
            onClick={onRegenerate}
          >
            <RotateCw className="h-3.5 w-3.5" />
            {regen.armed ? t("set.regenerateConfirm") : t("set.regenerate")}
          </Button>
        </div>
      </div>
    </Section>
  );
}

function ProxyStatusPanel() {
  const t = useT();
  const stats = useAppStore((s) => s.proxyStats);
  const refresh = useAppStore((s) => s.refreshProxyStats);
  const proxyRunning = useAppStore((s) => s.proxyRunning);
  const settings = useAppStore((s) => s.settings);

  // Safety-net refresh in case a metrics event is dropped (e.g. webview reload).
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [refresh]);

  const desc = proxyRunning
    ? t("proxy.running", { port: settings.proxyPort })
    : t("proxy.stopped");

  return (
    <Section
      icon={Activity}
      title={t("set.proxyStatusTitle")}
      desc={desc}
    >
      <div className="grid grid-cols-3 gap-3">
        <Stat label={t("set.totalForwarded")} value={stats.totalForwarded.toString()} />
        <Stat label={t("set.poolSize")} value={stats.poolSize.toString()} />
        <Stat
          label={t("set.currentHit")}
          value={stats.currentHitName ?? t("common.none")}
          highlight={stats.currentHitName ? "primary" : "muted"}
        />
      </div>
      <div className="mt-4">
        <div className="mb-2 text-xs font-medium text-muted">
          {t("set.failureCount")}
        </div>
        {stats.failures.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-muted/80">
            {t("set.noFailures")}
          </p>
        ) : (
          <ul className="max-h-44 space-y-1.5 overflow-y-auto">
            {stats.failures.map((f) => (
              <li
                key={f.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-2/50 px-3 py-1.5"
              >
                <span className="truncate text-sm">{f.name}</span>
                <span className="rounded-full bg-danger/15 px-2 py-0.5 font-mono text-xs text-danger">
                  {f.count}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}

function Stat({
  label,
  value,
  highlight = "primary",
}: {
  label: string;
  value: string;
  highlight?: "primary" | "muted";
}) {
  return (
    <div className="rounded-xl border border-border bg-surface-2/50 px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div
        className={`mt-1 truncate font-mono text-base font-semibold ${
          highlight === "primary" ? "text-primary" : "text-muted"
        }`}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}

function CleanupPanel() {
  const t = useT();
  const { doClearCaches, busy } = useConfigFile();
  const confirm = useConfirm();

  const onClear = async () => {
    if (!confirm.armed) {
      confirm.arm();
      return;
    }
    confirm.disarm();
    try {
      await doClearCaches();
    } catch {
      /* toast already shown */
    }
  };

  return (
    <Section icon={Trash2} title={t("set.cleanTitle")} desc={t("set.cleanDesc")}>
      <Button
        variant={confirm.armed ? "danger" : "secondary"}
        size="sm"
        onClick={onClear}
        loading={busy}
      >
        <Trash2 className="h-3.5 w-3.5" />
        {confirm.armed ? t("set.cleanConfirm") : t("set.cleanButton")}
      </Button>
    </Section>
  );
}

function UpdatePanel() {
  const t = useT();
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const phase = useUpdateStore((s) => s.phase);
  const check = useUpdateStore((s) => s.check);
  const info = useUpdateStore((s) => s.info);
  const openModal = useUpdateStore((s) => s.openModal);
  const [version, setVersion] = useState<string>("");
  const [autostartActual, setAutostartActual] = useState<boolean | null>(null);

  useEffect(() => {
    getAppVersion()
      .then(setVersion)
      .catch(() => setVersion(""));
    isAutostart()
      .then(setAutostartActual)
      .catch(() => setAutostartActual(null));
  }, []);

  const toggleAutostart = async (next: boolean) => {
    // Optimistic UI, but reconcile with the OS state since elevation prompts
    // or sandbox policy can silently refuse the flip.
    updateSettings({ autostart: next });
    try {
      const real = await setAutostart(next);
      setAutostartActual(real);
      if (real !== next) {
        updateSettings({ autostart: real });
        toast.warning(t("update.autostartMismatch"));
      } else {
        toast.success(next ? t("update.autostartOn") : t("update.autostartOff"));
      }
    } catch (e) {
      updateSettings({ autostart: !next });
      toast.error(t("update.autostartFailed"), String(e));
    }
  };

  const checking = phase === "checking";
  const installing = phase === "installing";

  return (
    <Section icon={ArrowUpCircle} title={t("update.sectionTitle")} desc={t("update.sectionDesc")}>
      <div className="space-y-1.5 text-sm">
        <Row label={t("update.currentVersion")}>
          <span className="font-mono tabular-nums text-muted">
            {version ? `v${version}` : t("update.versionUnknown")}
          </span>
        </Row>
        <Row label={t("update.autoCheck")}>
          <Switch
            checked={settings.autoCheckUpdate}
            onChange={(v) => updateSettings({ autoCheckUpdate: v })}
          />
        </Row>
        <Row label={t("update.autoInstall")}>
          <Switch
            checked={settings.autoInstallUpdate}
            onChange={(v) => updateSettings({ autoInstallUpdate: v })}
            disabled={!settings.autoCheckUpdate}
          />
        </Row>
        <Row label={t("update.autostart")}>
          <Switch
            checked={autostartActual ?? settings.autostart}
            onChange={toggleAutostart}
          />
        </Row>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={() => (info ? openModal() : check({ silent: false }))}
          loading={checking || installing}
          disabled={installing}
        >
          <ArrowUpCircle className="h-3.5 w-3.5" />
          {info ? t("update.viewUpdate") : t("update.checkNow")}
        </Button>
        {info && (
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
            {t("update.foundShort", { version: info.version })}
          </span>
        )}
        {autostartActual === null && (
          <span className="flex items-center gap-1 text-[11px] text-muted/70">
            <Power className="h-3 w-3" /> {t("update.autostartProbeFailed")}
          </span>
        )}
      </div>
    </Section>
  );
}

export function Settings() {
  const t = useT();
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const env = useAppStore((s) => s.claudeEnv);
  const detecting = useAppStore((s) => s.detecting);
  const refreshEnv = useAppStore((s) => s.refreshEnv);

  const { claudeConfig, refresh, backups, loadBackups, doBackup, doRestore, busy } =
    useConfigFile();

  const testNotify = async () => {
    try {
      await notifySystem(t("notify.testTitle"), t("notify.testBody"));
      toast.success(t("notify.testTitle"), t("notify.testBody"));
    } catch (e) {
      toast.error(t("notify.testTitle"), String(e));
    }
  };

  useEffect(() => {
    loadBackups();
    refresh();
  }, [loadBackups, refresh]);

  // Mask the current key from settings.json — it's our proxy key, not secret,
  // but a smaller footprint reads cleaner.
  const displayedConfigKey = useMemo(
    () => (claudeConfig?.currentKey ? maskKey(claudeConfig.currentKey) : t("set.notSet")),
    [claudeConfig?.currentKey, t],
  );

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="mx-auto grid max-w-3xl gap-4">
        {/* proxy credentials */}
        <ProxyCredentials />

        {/* proxy status panel */}
        <ProxyStatusPanel />

        {/* rotation & monitoring */}
        <Section
          icon={RotateCw}
          title={t("set.rotationTitle")}
          desc={t("set.rotationDesc")}
        >
          <div className="grid grid-cols-2 gap-4">
            <Select
              label={t("set.strategy")}
              value={settings.rotationStrategy}
              onValueChange={(v) =>
                updateSettings({ rotationStrategy: v as RotationStrategy })
              }
              options={[
                { value: "sequential", label: t("strategy.sequential") },
                { value: "quota", label: t("strategy.quota") },
                { value: "latency", label: t("strategy.latency") },
              ]}
            />
            <TextField
              label={t("set.threshold")}
              type="number"
              min={0}
              max={100}
              value={settings.quotaWarnThreshold}
              onChange={(e) =>
                updateSettings({ quotaWarnThreshold: Number(e.target.value) })
              }
            />
            <TextField
              label={t("set.timeout")}
              type="number"
              min={3}
              value={Math.round(settings.requestTimeoutMs / 1000)}
              onChange={(e) =>
                updateSettings({ requestTimeoutMs: Math.max(3, Number(e.target.value)) * 1000 })
              }
            />
            <TextField
              label={t("set.interval")}
              type="number"
              min={0}
              value={settings.monitorIntervalSec}
              onChange={(e) =>
                updateSettings({ monitorIntervalSec: Math.max(0, Number(e.target.value)) })
              }
            />
            <TextField
              label={t("set.activeWatch")}
              type="number"
              min={0}
              value={settings.activeWatchSec}
              onChange={(e) =>
                updateSettings({ activeWatchSec: Math.max(0, Number(e.target.value)) })
              }
            />
          </div>
          <div className="mt-2 divide-y divide-border/60">
            <Row label={t("set.autoRotateRow")}>
              <Switch
                checked={settings.autoRotate}
                onChange={(v) => updateSettings({ autoRotate: v })}
              />
            </Row>
            <Row label={t("set.autoBackupRow")}>
              <Switch
                checked={settings.autoBackup}
                onChange={(v) => updateSettings({ autoBackup: v })}
              />
            </Row>
            <Row label={t("set.quotaQueryRow")}>
              <Switch
                checked={settings.quotaQueryEnabled}
                onChange={(v) => updateSettings({ quotaQueryEnabled: v })}
              />
            </Row>
            <Row label={t("set.desktopNotifyRow")}>
              <Switch
                checked={settings.desktopNotifications}
                onChange={(v) => updateSettings({ desktopNotifications: v })}
              />
            </Row>
          </div>
          <div className="mt-3">
            <Button variant="secondary" size="sm" onClick={testNotify}>
              <BellRing className="h-3.5 w-3.5" /> {t("set.testNotify")}
            </Button>
          </div>
        </Section>

        {/* default connection */}
        <Section
          icon={ServerCog}
          title={t("set.connTitle")}
          desc={t("set.connDesc")}
        >
          <div className="grid grid-cols-1 gap-4">
            <TextField
              label={t("set.defaultUrl")}
              value={settings.defaultBaseUrl}
              onChange={(e) => updateSettings({ defaultBaseUrl: e.target.value })}
            />
            <div className="grid grid-cols-2 gap-4">
              <Select
                label={t("set.defaultAuth")}
                value={settings.defaultAuthField}
                onValueChange={(v) =>
                  updateSettings({ defaultAuthField: v as AuthField })
                }
                options={AUTH_FIELD_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
              />
              <TextField
                label={t("set.testModel")}
                value={settings.testModel}
                onChange={(e) => updateSettings({ testModel: e.target.value })}
              />
            </div>
          </div>
        </Section>

        {/* claude config takeover */}
        <Section
          icon={FileCog}
          title={t("set.configTitle")}
          desc={t("set.configDesc")}
        >
          <div className="rounded-xl border border-border bg-surface-2/50 p-3 text-xs">
            <p className="break-all font-mono text-muted">
              {claudeConfig?.settingsPath ?? "~/.claude/settings.json"}
            </p>
            <div className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
              <span className="text-muted">
                {t("set.currentKey")}
                <span className="text-text">{displayedConfigKey}</span>
              </span>
              <span className="text-muted">
                {t("set.authFieldLabel")}
                <span className="text-text">{claudeConfig?.currentAuthField ?? t("common.none")}</span>
              </span>
              <span className="col-span-full text-muted">
                {t("set.urlLabel")}
                <span className="text-text">{claudeConfig?.currentBaseUrl ?? t("common.default")}</span>
              </span>
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <Button variant="secondary" size="sm" onClick={refresh}>
              <RotateCw className="h-3.5 w-3.5" /> {t("set.reread")}
            </Button>
            <Button variant="secondary" size="sm" onClick={doBackup} loading={busy}>
              <DatabaseBackup className="h-3.5 w-3.5" /> {t("set.backupNow")}
            </Button>
          </div>
        </Section>

        {/* backups */}
        <Section icon={Archive} title={t("set.backupTitle")} desc={t("set.backupDesc")}>
          {backups.length === 0 ? (
            <p className="py-2 text-sm text-muted">{t("set.noBackups")}</p>
          ) : (
            <div className="max-h-56 space-y-1.5 overflow-y-auto">
              {backups.map((b) => (
                <div
                  key={b.fileName}
                  className="flex items-center gap-3 rounded-lg border border-border bg-surface-2/50 px-3 py-2"
                >
                  <HardDriveDownload className="h-4 w-4 shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{b.fileName}</p>
                    <p className="text-[11px] text-muted">
                      {formatDateTime(b.createdAt)} · {(b.size / 1024).toFixed(1)} KB
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => doRestore(b.fileName)}
                    disabled={busy}
                  >
                    {t("set.restore")}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* updater & autostart */}
        <UpdatePanel />

        {/* cleanup & reset */}
        <CleanupPanel />

        {/* environment */}
        <Section icon={Gauge} title={t("set.envTitle")} desc={t("set.envDesc")}>
          <div className="space-y-1.5 text-sm">
            <Row label={t("set.installStatus")}>
              <span className={env?.installed ? "text-success" : "text-danger"}>
                {env?.installed ? t("sidebar.installed") : t("sidebar.notDetected")}
              </span>
            </Row>
            <Row label={t("set.version")}>
              <span className="text-muted">{env?.version ?? t("common.none")}</span>
            </Row>
            <Row label={t("set.installMethod")}>
              <span className="text-muted">{env?.installMethod ?? t("common.none")}</span>
            </Row>
          </div>
          {env?.binaryPath && (
            <p className="mt-1 break-all font-mono text-[11px] text-muted">{env.binaryPath}</p>
          )}
          <Button
            className="mt-3"
            variant="secondary"
            size="sm"
            onClick={refreshEnv}
            loading={detecting}
          >
            <RotateCw className="h-3.5 w-3.5" /> {t("set.recheckEnv")}
          </Button>
        </Section>
      </div>
    </div>
  );
}

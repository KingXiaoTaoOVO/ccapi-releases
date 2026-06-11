import { useCallback, useEffect, useState } from "react";
import {
  Bell,
  KeyRound,
  Languages,
  Moon,
  Network,
  PowerOff,
  RefreshCw,
  ShieldCheck,
  Sliders,
  Sun,
  Type,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { TextField } from "@/components/ui/TextField";
import { useI18n, useT } from "@/i18n";
import { useAppStore } from "@/store/useAppStore";
import { useAuthStore } from "@/store/useAuthStore";
import { useThemeStore } from "@/store/useThemeStore";
import { setAutostart } from "@/services/updater";
import { changeEntryPassword } from "@/services/tauri";
import { apiGet } from "@/services/apiClient";
import { notify } from "@/services/notify";
import { prompt } from "@/store/usePromptStore";
import type { NetworkProxyConfig, Theme } from "@/types";

/**
 * Phase-2 偏好设置面板。所有字段即时持久化（settings/persist）。
 * UI 缩放 + 字号会立即应用到 <html>，断电也会因为 store rehydrate 而恢复。
 */
export function PreferencesPanel() {
  const t = useT();
  const lang = useI18n((s) => s.lang);
  const setLang = useI18n((s) => s.setLang);
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const scope = useAuthStore((s) => s.session?.scope ?? null);
  const isAdmin = scope === "server";

  const uiScale = settings.uiScale ?? 1;
  const fontSize = settings.fontSize ?? 14;
  const networkProxy: NetworkProxyConfig = settings.networkProxy ?? { mode: "system" };

  const [channels, setChannels] = useState<{ id: number; name: string }[]>([]);
  useEffect(() => {
    if (!isAdmin) return;
    void apiGet<{ channels: { id: number; name: string }[] }>("/api/admin/channels")
      .then((r) => setChannels(r.channels))
      .catch(() => setChannels([]));
  }, [isAdmin]);

  // 立即应用到 <html>
  useEffect(() => {
    const root = document.documentElement;
    root.style.fontSize = `${fontSize}px`;
    root.style.setProperty("--ui-scale", String(uiScale));
    root.style.zoom = String(uiScale);
  }, [uiScale, fontSize]);

  const patch = (p: Partial<typeof settings>) => updateSettings(p);

  const onChangeEntryPw = useCallback(async () => {
    const values = await prompt({
      title: t("prefs.entryPw.title"),
      description: t("prefs.entryPw.desc"),
      fields: [
        {
          name: "old",
          label: t("admin.cfg.entryOld"),
          type: "password",
          required: true,
          autoFocus: true,
        },
        {
          name: "new",
          label: t("admin.cfg.entryNew"),
          type: "password",
          required: true,
          validate: (v) =>
            v.length >= 6 ? null : t("auth.cp.short"),
        },
        {
          name: "confirm",
          label: t("auth.cp.confirm"),
          type: "password",
          required: true,
          validate: (v, all) =>
            v === all.new ? null : t("auth.cp.mismatch"),
        },
      ],
    });
    if (!values) return;
    try {
      await changeEntryPassword(values.old, values.new);
      notify("success", t("prefs.entryPw.ok"));
    } catch (e: any) {
      notify("error", t("prefs.entryPw.fail"), e?.message ?? String(e));
    }
  }, [t]);

  return (
    <section className="space-y-4 rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
      <header className="flex items-center gap-2">
        <Sliders className="h-4 w-4 text-primary" />
        <h2 className="text-base font-semibold">{t("prefs.title")}</h2>
      </header>
      <p className="text-xs text-muted">{t("prefs.subtitle")}</p>

      {/* 外观 */}
      <Group title={t("prefs.group.appearance")}>
        <Row
          icon={theme === "dark" ? Moon : Sun}
          title={t("prefs.theme")}
          desc={t("prefs.theme.desc")}
          control={
            <Select
              value={theme}
              onValueChange={(v) => setTheme(v as Theme)}
              options={[
                { value: "system", label: t("theme.system") },
                { value: "light", label: t("theme.light") },
                { value: "dark", label: t("theme.dark") },
              ]}
            />
          }
        />
        <Row
          icon={Languages}
          title={t("prefs.lang")}
          desc={t("prefs.lang.desc")}
          control={
            <Select
              value={lang}
              onValueChange={(v) => setLang(v as "zh" | "en")}
              options={[
                { value: "zh", label: "中文" },
                { value: "en", label: "English" },
              ]}
            />
          }
        />
        <Row
          icon={Sliders}
          title={t("prefs.scale")}
          desc={t("prefs.scale.desc")}
          control={
            <Select
              value={String(uiScale)}
              onValueChange={(v) => patch({ uiScale: Number(v) })}
              options={[
                { value: "0.85", label: t("prefs.scale.small") },
                { value: "1", label: t("prefs.scale.medium") },
                { value: "1.15", label: t("prefs.scale.large") },
                { value: "1.3", label: t("prefs.scale.xlarge") },
              ]}
            />
          }
        />
        <Row
          icon={Type}
          title={t("prefs.fontSize")}
          desc={t("prefs.fontSize.desc")}
          control={
            <Select
              value={String(fontSize)}
              onValueChange={(v) => patch({ fontSize: Number(v) })}
              options={[12, 13, 14, 15, 16, 18].map((n) => ({
                value: String(n),
                label: `${n}px`,
              }))}
            />
          }
        />
      </Group>

      {/* 系统 */}
      <Group title={t("prefs.group.system")}>
        <Row
          icon={Bell}
          title={t("prefs.notif")}
          desc={t("prefs.notif.desc")}
          control={
            <Switch
              checked={settings.desktopNotifications}
              onChange={(v) => patch({ desktopNotifications: v })}
            />
          }
        />
        <Row
          icon={Zap}
          title={t("prefs.autostart")}
          desc={t("prefs.autostart.desc")}
          control={
            <Switch
              checked={settings.autostart}
              onChange={(v) => {
                patch({ autostart: v });
                setAutostart(v).catch((e: any) =>
                  notify("error", t("prefs.autostartFail"), e?.message),
                );
              }}
            />
          }
        />
        <Row
          icon={PowerOff}
          title={t("prefs.tray")}
          desc={t("prefs.tray.desc")}
          control={
            <Switch
              checked={settings.minimizeToTray ?? true}
              onChange={(v) => patch({ minimizeToTray: v })}
            />
          }
        />
      </Group>

      {/* 安全 */}
      <Group title={t("prefs.group.security")}>
        <Row
          icon={ShieldCheck}
          title={t("prefs.alwaysConfirm")}
          desc={t("prefs.alwaysConfirm.desc")}
          control={
            <Switch
              checked={settings.alwaysConfirmDangerous ?? true}
              onChange={(v) => patch({ alwaysConfirmDangerous: v })}
            />
          }
        />
        <Row
          icon={ShieldCheck}
          title={t("prefs.lockTimeout")}
          desc={t("prefs.lockTimeout.desc")}
          control={
            <Select
              value={String(settings.lockTimeoutSecs ?? 0)}
              onValueChange={(v) => patch({ lockTimeoutSecs: Number(v) })}
              options={[
                { value: "0", label: t("prefs.lock.off") },
                { value: "300", label: "5m" },
                { value: "600", label: "10m" },
                { value: "1800", label: "30m" },
                { value: "3600", label: "1h" },
              ]}
            />
          }
        />
        {isAdmin && (
          <Row
            icon={KeyRound}
            title={t("prefs.entryPw")}
            desc={t("prefs.entryPw.row.desc")}
            control={
              <Button size="sm" variant="ghost" onClick={() => void onChangeEntryPw()}>
                {t("prefs.entryPw.btn")}
              </Button>
            }
          />
        )}
      </Group>

      {/* 网络 */}
      <Group title={t("prefs.group.network")}>
        <Row
          icon={Network}
          title={t("prefs.netProxy")}
          desc={t("prefs.netProxy.desc")}
          control={
            <Select
              value={networkProxy.mode}
              onValueChange={(v) =>
                patch({
                  networkProxy: {
                    mode: v as NetworkProxyConfig["mode"],
                    url: networkProxy.url,
                  },
                })
              }
              options={[
                { value: "system", label: t("prefs.netProxy.system") },
                { value: "direct", label: t("prefs.netProxy.direct") },
                { value: "http", label: "HTTP" },
                { value: "socks5", label: "SOCKS5" },
              ]}
            />
          }
        />
        {(networkProxy.mode === "http" || networkProxy.mode === "socks5") && (
          <div className="px-2 pb-2">
            <TextField
              label={t("prefs.netProxy.url")}
              value={networkProxy.url ?? ""}
              onChange={(e) =>
                patch({
                  networkProxy: { mode: networkProxy.mode, url: e.target.value },
                })
              }
              placeholder={
                networkProxy.mode === "socks5"
                  ? "socks5://127.0.0.1:1080"
                  : "http://127.0.0.1:7890"
              }
              hint={t("prefs.netProxy.urlHint")}
            />
          </div>
        )}
      </Group>

      {/* API */}
      <Group title={t("prefs.group.api")}>
        {isAdmin && (
          <Row
            icon={Network}
            title={t("prefs.defaultChannel")}
            desc={t("prefs.defaultChannel.desc")}
            control={
              <Select
                value={String(settings.defaultChannelId ?? 0)}
                onValueChange={(v) => patch({ defaultChannelId: Number(v) })}
                options={[
                  { value: "0", label: t("prefs.defaultChannel.auto") },
                  ...channels.map((c) => ({
                    value: String(c.id),
                    label: `#${c.id} ${c.name}`,
                  })),
                ]}
              />
            }
          />
        )}
        <Row
          icon={RefreshCw}
          title={t("prefs.autoRetry")}
          desc={t("prefs.autoRetry.desc")}
          control={
            <Select
              value={String(settings.autoRetryCount ?? 1)}
              onValueChange={(v) => patch({ autoRetryCount: Number(v) })}
              options={["0", "1", "2", "3"].map((n) => ({
                value: n,
                label: `${n} ×`,
              }))}
            />
          }
        />
        <Row
          icon={Zap}
          title={t("prefs.autoUpdate")}
          desc={t("prefs.autoUpdate.desc")}
          control={
            <Switch
              checked={settings.autoCheckUpdate}
              onChange={(v) => patch({ autoCheckUpdate: v })}
            />
          }
        />
        <Row
          icon={Zap}
          title={t("prefs.autoInstall")}
          desc={t("prefs.autoInstall.desc")}
          control={
            <Switch
              checked={settings.autoInstallUpdate}
              onChange={(v) => patch({ autoInstallUpdate: v })}
            />
          }
        />
      </Group>
    </section>
  );
}

function Group({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted/80">
        {title}
      </p>
      <div className="space-y-2 rounded-xl border border-border bg-surface-2/30 p-2">
        {children}
      </div>
    </div>
  );
}

function Row({
  icon: Icon,
  title,
  desc,
  control,
}: {
  icon: typeof Sliders;
  title: string;
  desc: string;
  control: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg px-2.5 py-2 hover:bg-surface-2/40">
      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted">{desc}</p>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

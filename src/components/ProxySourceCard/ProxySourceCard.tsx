import { useEffect, useRef, useState } from "react";
import { Cloud, Copy, HardDrive, Info, Terminal, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { useT } from "@/i18n";
import { apiPost } from "@/services/apiClient";
import { useAppStore } from "@/store/useAppStore";
import { useAuthStore } from "@/store/useAuthStore";
import { useModeStore } from "@/store/useModeStore";
import { notify } from "@/services/notify";
import {
  configureClaudeCode,
  configureCodex,
  readClaudeConfig,
  readCodexConfig,
  setProxyOfficialMode,
  type CodexConfigReport,
  type CodexCurrentConfig,
} from "@/services/tauri";
import type { ClaudeConfig } from "@/types";

/**
 * 代理来源切换：
 * - local：走本机出网，使用本地 API Key 池。不扣激活码 / 订阅额度，
 *   但每次调用仍会被 proxy.rs 记入 usage（带 source=local 标识）。
 * - official：走 CCAPI 服务端的"官方代理"——由管理员配置的渠道转发，
 *   按用户分组倍率 + 模型倍率扣费。本批后端路由尚未联通，
 *   选择后会回退到本地，并提示用户。
 */
export function ProxySourceCard() {
  const t = useT();
  const source = useAppStore((s) => s.settings.proxySource ?? "local");
  const updateSettings = useAppStore((s) => s.updateSettings);
  const serverUrl = useModeStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.session?.tokens.accessToken);
  const officialEndpoint = serverUrl
    ? `${serverUrl.replace(/\/+$/, "")}/api/v1`
    : null;

  // 应用桥接：official → 本地代理转发到 serverUrl + JWT；local → 清掉
  const appliedRef = useRef<string>("");
  useEffect(() => {
    const sig = `${source}|${serverUrl ?? ""}|${token ?? ""}`;
    if (sig === appliedRef.current) return;
    appliedRef.current = sig;
    if (source === "official" && serverUrl && token) {
      setProxyOfficialMode({ serverUrl, jwt: token }).catch((e: any) =>
        notify("error", t("proxySource.bridgeFail"), e?.message),
      );
    } else {
      setProxyOfficialMode({ serverUrl: null, jwt: null }).catch(() => {
        /* ignore — 本地代理可能没启动 */
      });
    }
  }, [source, serverUrl, token, t]);

  const choose = (v: "local" | "official") => {
    updateSettings({ proxySource: v });
    if (v === "official") {
      notify(
        "info",
        t("proxySource.bridgeEnabled"),
        t("proxySource.bridgeEnabledDesc"),
      );
    } else {
      // 切到本地代理：自动把本机 axum 服务器起起来。否则 Chat / 外部 CLI
      // 走 http://127.0.0.1:port 会立刻 "Failed to fetch"。
      void ensureProxyRunningCmd();
      notify("info", t("proxySource.bridgeDisabled"));
    }
  };

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify("success", t("proxySource.copied", { what }));
    } catch (e: any) {
      notify("error", t("common.copyFail"), e?.message);
    }
  };

  // ---------- 一键配置外部 CLI ----------
  const proxyPort = useAppStore((s) => s.settings.proxyPort);
  const proxyKey = useAppStore((s) => s.settings.proxyKey);
  const proxyRunning = useAppStore((s) => s.proxyRunning);
  const restartProxy = useAppStore((s) => s.restartProxy);
  const ensureProxyRunningCmd = useAppStore((s) => s.ensureProxyRunning);
  const [busy, setBusy] = useState<string | null>(null);
  const [claudeCfg, setClaudeCfg] = useState<ClaudeConfig | null>(null);
  const [codexCfg, setCodexCfg] = useState<CodexCurrentConfig | null>(null);

  /** 本地代理必须先跑起来，否则 Claude/Codex 配置写完也只会 ConnectionRefused。
   *  这里走 restartProxy 是因为「一键配置外部 CLI」希望同时把 Claude settings.json
   *  也重写到正确端口；纯启动用 store 的 ensureProxyRunningCmd 即可。 */
  const ensureProxyRunning = async (): Promise<boolean> => {
    if (proxyRunning) return true;
    try {
      await restartProxy(proxyPort ?? 8765);
      return useAppStore.getState().proxyRunning;
    } catch (e: any) {
      notify("error", t("proxySource.proxyStartFail"), e?.message ?? String(e));
      return false;
    }
  };

  const refreshExternal = async () => {
    const [cc, cx] = await Promise.all([
      readClaudeConfig().catch(() => null),
      readCodexConfig().catch(() => null),
    ]);
    setClaudeCfg(cc);
    setCodexCfg(cx);
  };

  useEffect(() => {
    void refreshExternal();
  }, []);

  /** local 模式直接用本机代理的 base+key。 */
  const localCreds = (target: "claude" | "codex") => {
    const localBase = `http://127.0.0.1:${proxyPort ?? 8765}`;
    return {
      baseUrl: target === "claude" ? localBase : `${localBase}/v1`,
      token: proxyKey || "",
    };
  };

  /**
   * official 模式：自动创建一个专属永久 token 并把明文 burn 到外部 CLI 配置。
   * 失败时回退到 JWT（15 分钟限制，并提示用户）。
   */
  const provisionTokenFor = async (
    target: "claude" | "codex",
  ): Promise<string | null> => {
    try {
      const hostname =
        typeof window !== "undefined" && window.navigator?.platform
          ? window.navigator.platform
          : "device";
      const stamp = new Date().toISOString().slice(0, 10);
      const r = await apiPost<{ token: string; id: number }>(
        "/api/me/tokens",
        {
          name: `Auto · ${target === "claude" ? "Claude Code" : "Codex"} · ${hostname} · ${stamp}`,
          quotaUsd: null,
          modelsAllowed: null,
          ipWhitelist: null,
          expiresAt: null,
        },
      );
      return r.token;
    } catch (e: any) {
      notify("warning", t("proxySource.tokenAutoFail"), e?.message);
      return null;
    }
  };

  const credsForExternal = async (
    target: "claude" | "codex",
  ): Promise<{ baseUrl: string; token: string; usingApiToken: boolean } | null> => {
    if (source === "official") {
      if (!serverUrl || !token) return null;
      const root = serverUrl.replace(/\/+$/, "");
      // 优先创建永久 API token；失败回退用当前 JWT
      const fresh = await provisionTokenFor(target);
      return {
        baseUrl: `${root}/api/v1`,
        token: fresh ?? token,
        usingApiToken: !!fresh,
      };
    }
    const { baseUrl, token: tk } = localCreds(target);
    return { baseUrl, token: tk, usingApiToken: false };
  };

  const onConfigureClaude = async () => {
    setBusy("claude");
    try {
      // local 模式：必须先确保本机代理已绑端口监听，否则 Claude 调用会 ConnectionRefused
      if (source === "local") {
        const ok = await ensureProxyRunning();
        if (!ok) {
          setBusy(null);
          return;
        }
      }
      const creds = await credsForExternal("claude");
      if (!creds) {
        notify("error", t("proxySource.configCredsMissing"));
        return;
      }
      const path = await configureClaudeCode({
        baseUrl: creds.baseUrl,
        token: creds.token,
        authField: "ANTHROPIC_AUTH_TOKEN",
      });
      notify(
        "success",
        t("proxySource.claudeOk"),
        creds.usingApiToken
          ? t("proxySource.writtenWithToken", { path })
          : t("proxySource.writtenTo", { path }),
      );
      void refreshExternal();
    } catch (e: any) {
      notify("error", t("proxySource.claudeFail"), e?.message);
    } finally {
      setBusy(null);
    }
  };

  const onConfigureCodex = async () => {
    setBusy("codex");
    try {
      if (source === "local") {
        const ok = await ensureProxyRunning();
        if (!ok) {
          setBusy(null);
          return;
        }
      }
      const creds = await credsForExternal("codex");
      if (!creds) {
        notify("error", t("proxySource.configCredsMissing"));
        return;
      }
      const r: CodexConfigReport = await configureCodex({
        baseUrl: creds.baseUrl,
        token: creds.token,
        model: "gpt-4o",
      });
      notify(
        "success",
        t("proxySource.codexOk"),
        creds.usingApiToken
          ? t("proxySource.writtenWithToken", { path: r.configPath })
          : t("proxySource.writtenTo", { path: r.configPath }),
      );
      void refreshExternal();
    } catch (e: any) {
      notify("error", t("proxySource.codexFail"), e?.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
      <header className="flex items-center gap-2">
        <Info className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold">{t("proxySource.title")}</h2>
      </header>
      <p className="mt-1 text-xs text-muted">{t("proxySource.subtitle")}</p>
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Option
          active={source === "local"}
          onClick={() => choose("local")}
          icon={HardDrive}
          title={t("proxySource.local")}
          desc={t("proxySource.local.desc")}
          tag={t("proxySource.local.tag")}
        />
        <Option
          active={source === "official"}
          onClick={() => choose("official")}
          icon={Cloud}
          title={t("proxySource.official")}
          desc={t("proxySource.official.desc")}
          tag={t("proxySource.official.tag")}
        />
      </div>

      {/* 一键配置外部 CLI */}
      <div className="mt-4 space-y-2 rounded-xl border border-border/60 bg-surface-2/40 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Wand2 className="h-3.5 w-3.5 text-primary" />
          <span className="text-xs text-muted">{t("proxySource.quickConfig")}</span>
          <div className="ml-auto flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void onConfigureClaude()}
              loading={busy === "claude"}
            >
              <Terminal className="h-3.5 w-3.5" />
              {t("proxySource.btn.claude")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void onConfigureCodex()}
              loading={busy === "codex"}
            >
              <Terminal className="h-3.5 w-3.5" />
              {t("proxySource.btn.codex")}
            </Button>
          </div>
        </div>
        <StatusLine
          label={t("proxySource.cur.claude")}
          configured={!!claudeCfg?.currentBaseUrl}
          value={claudeCfg?.currentBaseUrl ?? t("proxySource.cur.notConfigured")}
        />
        <StatusLine
          label={t("proxySource.cur.codex")}
          configured={codexCfg?.modelProvider === "ccapi"}
          value={
            codexCfg?.configExists
              ? `${codexCfg.modelProvider ?? "—"} · ${codexCfg.ccapiBaseUrl ?? "—"}`
              : t("proxySource.cur.notConfigured")
          }
        />
      </div>

      {source === "official" && officialEndpoint && (
        <div className="mt-4 space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-3 text-xs">
          <p className="font-medium text-primary">
            {t("proxySource.endpointTitle")}
          </p>
          <p className="text-muted">{t("proxySource.endpointDesc")}</p>
          <div className="space-y-1.5">
            <Row label={t("proxySource.openaiEndpoint")} value={`${officialEndpoint}/chat/completions`} onCopy={copy} />
            <Row label={t("proxySource.anthropicEndpoint")} value={`${officialEndpoint}/messages`} onCopy={copy} />
            {token && (
              <Row
                label="Authorization"
                value={`Bearer ${token}`}
                onCopy={copy}
                masked
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function StatusLine({
  label,
  value,
  configured,
}: {
  label: string;
  value: string;
  configured: boolean;
}) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          configured ? "bg-success" : "bg-muted/40",
        )}
      />
      <span className="w-24 shrink-0 text-muted">{label}</span>
      <code className="flex-1 truncate font-mono text-muted/90">{value}</code>
    </div>
  );
}

function Row({
  label,
  value,
  onCopy,
  masked,
}: {
  label: string;
  value: string;
  onCopy: (v: string, what: string) => void;
  masked?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-28 shrink-0 text-muted">{label}</span>
      <code className="flex-1 truncate rounded bg-surface-2/60 px-2 py-1 font-mono text-[11px]">
        {masked ? value.slice(0, 16) + "…" : value}
      </code>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => onCopy(value, label)}
        className="px-2"
      >
        <Copy className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function Option({
  icon: Icon,
  title,
  desc,
  tag,
  active,
  onClick,
}: {
  icon: typeof Cloud;
  title: string;
  desc: string;
  tag: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "no-drag flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition-colors",
        active
          ? "border-primary bg-primary/10"
          : "border-border bg-surface-2/40 hover:border-primary/40",
      )}
    >
      <div
        className={cn(
          "grid h-9 w-9 shrink-0 place-items-center rounded-lg",
          active ? "bg-primary/20 text-primary" : "bg-surface/70 text-muted",
        )}
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">{title}</p>
          <span
            className={cn(
              "rounded-full px-1.5 py-0.5 text-[10px]",
              active ? "bg-primary/20 text-primary" : "bg-surface text-muted",
            )}
          >
            {tag}
          </span>
        </div>
        <p className="mt-1 text-xs text-muted">{desc}</p>
      </div>
    </button>
  );
}

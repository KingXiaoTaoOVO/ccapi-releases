import { create } from "zustand";
import type {
  ApiKey,
  AppSettings,
  ClaudeConfig,
  ClaudeEnvInfo,
  ImportedKey,
  KeyStatus,
  PersistedState,
} from "@/types";
import {
  DEFAULT_SETTINGS,
  STORAGE_VERSION,
  DEFAULT_BASE_URL,
  DEFAULT_PROXY_PORT,
  generateProxyKey,
} from "@/lib/defaults";
import { uid } from "@/lib/format";
import { pickBest, pickNext, usableKeys } from "@/lib/rotation";
import { cooldownRemaining } from "@/lib/format";
import { detectClaude } from "@/services/claudeInstall";
import { activateKeyInClaude, readClaudeConfig } from "@/services/configManager";
import { deriveStatus, probeKey, queryQuota } from "@/services/apiMonitor";
import { loadPersisted, savePersisted } from "@/services/keyStore";
import {
  migrateToProxy,
  startProxy,
  stopProxy,
  setProxyKeys,
  setProxyToken,
  onProxySwitch,
  onProxyMetrics,
  proxyMetrics as fetchProxyMetrics,
  type ProxyMetrics,
} from "@/services/tauri";
import { t } from "@/i18n";
import { toast } from "./useToastStore";
import { notify, setDesktopNotifications } from "@/services/notify";
import { useThemeStore } from "./useThemeStore";
import { bindWorkspacePersist, useWorkspaceStore } from "./useWorkspaceStore";

export type View =
  | "dashboard"
  | "chat"
  | "usage"
  | "skills"
  | "mcp"
  | "rules"
  | "agents"
  | "tasks"
  | "logs"
  | "settings";

interface AppState {
  ready: boolean;
  view: View;

  keys: ApiKey[];
  settings: AppSettings;
  activeKeyId: string | null;

  claudeEnv: ClaudeEnvInfo | null;
  claudeConfig: ClaudeConfig | null;
  detecting: boolean;

  /** ids currently being health-checked. */
  checking: Record<string, boolean>;
  /** True only while a *user-initiated* "check all" sweep is in flight. */
  bulkChecking: boolean;
  /** Whether the local proxy is currently running. */
  proxyRunning: boolean;
  /** Live session metrics pushed from the proxy (totals + failure counts). */
  proxyStats: ProxyMetrics;

  // lifecycle
  init: () => Promise<void>;
  persist: () => void;

  // navigation
  setView: (view: View) => void;

  // env / config
  refreshEnv: () => Promise<void>;
  refreshClaudeConfig: () => Promise<void>;

  // key CRUD
  addKey: (input: Partial<ApiKey> & { name: string; key: string }) => ApiKey;
  updateKey: (id: string, patch: Partial<ApiKey>) => void;
  removeKey: (id: string) => void;
  removeKeys: (ids: string[]) => void;
  toggleKey: (id: string) => void;
  importKeys: (rows: ImportedKey[]) => number;
  reorderKeys: (orderedIds: string[]) => void;

  // activation & rotation
  setActiveKey: (id: string, opts?: { silent?: boolean }) => Promise<void>;
  rotateNext: (reason?: string) => Promise<boolean>;

  // local proxy
  /** Push the current ordered key pool to the running proxy (no-op if stopped). */
  syncProxyKeys: () => void;
  /** Restart the proxy on a new port; used when the user changes the port setting. */
  restartProxy: (port: number) => Promise<void>;
  /** Re-generate a fresh proxy token, push it to the proxy + Claude config. */
  regenerateProxyKey: () => Promise<void>;
  /** Manually refresh the metrics snapshot from the backend. */
  refreshProxyStats: () => Promise<void>;

  // monitoring
  checkKey: (id: string) => Promise<void>;
  /** Sweep all enabled keys. `manual` (default true) drives the button spinner. */
  checkAll: (opts?: { manual?: boolean }) => Promise<void>;
  setQuota: (id: string, used: number | undefined, limit: number | undefined) => void;
  startMonitor: () => void;
  stopMonitor: () => void;
  /** Fast watchdog that probes only the active key for quick auth-failure failover. */
  startActiveWatch: () => void;
  stopActiveWatch: () => void;

  // settings
  updateSettings: (patch: Partial<AppSettings>) => void;
  completeOnboarding: (patch: Partial<AppSettings>) => void;
}

let monitorTimer: ReturnType<typeof setInterval> | null = null;
let recoveryTimer: ReturnType<typeof setInterval> | null = null;
let activeWatchTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Rotation-notification throttle. Proxy-side failover can fire multiple switch
 * events within a couple of seconds when Claude Code retries; without this the
 * UI floods with identical "Auto-rotated to X" toasts. We allow at most one
 * notification per target id within ROTATE_NOTIFY_WINDOW_MS, and one
 * "no usable key" notification within the same window.
 */
const ROTATE_NOTIFY_WINDOW_MS = 30_000;
let lastRotateNotifyAt = 0;
let lastRotateNotifyId: string | null = null;
let lastNoUsableNotifyAt = 0;

let errorLogBound = false;
/**
 * Mirror unhandled browser errors / promise rejections into the persistent
 * log store so users can diagnose issues from the Logs view. Idempotent.
 */
function bindGlobalErrorLogging() {
  if (errorLogBound || typeof window === "undefined") return;
  errorLogBound = true;
  const wsLog = (
    level: "error" | "warning" | "info",
    source: string,
    message: string,
    detail?: string,
  ) => useWorkspaceStore.getState().log(level, source, message, detail);
  window.addEventListener("error", (e) => {
    wsLog(
      "error",
      "window.error",
      e.message || String(e.error ?? "Unknown error"),
      e.error?.stack,
    );
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    wsLog(
      "error",
      "promise.unhandled",
      typeof reason === "string" ? reason : reason?.message ?? String(reason),
      reason?.stack,
    );
  });
}

function shouldEmitRotateNotice(toId: string | null): boolean {
  const now = Date.now();
  if (toId === null) {
    if (now - lastNoUsableNotifyAt < ROTATE_NOTIFY_WINDOW_MS) return false;
    lastNoUsableNotifyAt = now;
    return true;
  }
  if (
    toId === lastRotateNotifyId &&
    now - lastRotateNotifyAt < ROTATE_NOTIFY_WINDOW_MS
  ) {
    return false;
  }
  lastRotateNotifyId = toId;
  lastRotateNotifyAt = now;
  return true;
}

function snapshot(s: AppState): PersistedState {
  const ws = useWorkspaceStore.getState();
  return {
    version: STORAGE_VERSION,
    keys: s.keys,
    settings: s.settings,
    activeKeyId: s.activeKeyId,
    theme: useThemeStore.getState().theme,
    skills: ws.skills,
    mcpServers: ws.mcpServers,
    rules: ws.rules,
    agents: ws.agents,
    tasks: ws.tasks,
    chats: ws.chats,
    logs: ws.logs,
  };
}

/** Order usable keys for the proxy pool: healthy first, by strategy, active first. */
function rankForProxy(
  keys: ApiKey[],
  strategy: AppSettings["rotationStrategy"],
  activeId: string | null,
): ApiKey[] {
  const sorted = [...usableKeys(keys)].sort((a, b) => {
    const ra = a.status === "active" ? 0 : 1;
    const rb = b.status === "active" ? 0 : 1;
    if (ra !== rb) return ra - rb;
    if (strategy === "quota") {
      return (b.quotaRemainingPct ?? 100) - (a.quotaRemainingPct ?? 100);
    }
    if (strategy === "latency") {
      return (a.latencyMs ?? Number.MAX_SAFE_INTEGER) - (b.latencyMs ?? Number.MAX_SAFE_INTEGER);
    }
    return a.order - b.order;
  });
  if (activeId) {
    const i = sorted.findIndex((k) => k.id === activeId);
    if (i > 0) sorted.unshift(sorted.splice(i, 1)[0]);
  }
  return sorted;
}

function quotaPct(used?: number, limit?: number): number | undefined {
  if (typeof used !== "number" || typeof limit !== "number" || limit <= 0) {
    return undefined;
  }
  return Math.max(0, Math.min(100, Math.round(((limit - used) / limit) * 100)));
}

const EMPTY_METRICS: ProxyMetrics = {
  running: false,
  port: 0,
  poolSize: 0,
  totalForwarded: 0,
  currentHitId: null,
  currentHitName: null,
  failures: [],
};

/**
 * `init()` is guarded so React 18 StrictMode (which intentionally double-mounts
 * effects in development) and any accidental re-call cannot register the
 * proxy event listeners twice. The promise is reused across concurrent calls.
 */
let initPromise: Promise<void> | null = null;

/**
 * Recent-rotation circuit breaker. If the proxy rotates through several
 * different destination keys inside SWEEP_WINDOW_MS and every single one
 * failed (HTTP >= 400 with no successful 200 in between), we infer the
 * upstream provider has collapsed (e.g. "organization disabled") and
 * temporarily disable auto-rotation so the proxy stops thrashing.
 */
const SWEEP_WINDOW_MS = 60_000;
const SWEEP_KEY_THRESHOLD = 5;
let recentRotations: { id: string; at: number; ok: boolean }[] = [];
let breakerTrippedAt = 0;

function recordRotation(toId: string, ok: boolean): boolean {
  const now = Date.now();
  recentRotations = recentRotations.filter((r) => now - r.at < SWEEP_WINDOW_MS);
  recentRotations.push({ id: toId, at: now, ok });
  if (ok) return false;
  if (now - breakerTrippedAt < SWEEP_WINDOW_MS) return false;
  const distinctFailedIds = new Set(
    recentRotations.filter((r) => !r.ok).map((r) => r.id),
  );
  const hadSuccess = recentRotations.some((r) => r.ok);
  if (!hadSuccess && distinctFailedIds.size >= SWEEP_KEY_THRESHOLD) {
    breakerTrippedAt = now;
    return true;
  }
  return false;
}

/**
 * Long, side-effectful boot sequence: hydrate persisted state, start the
 * proxy, attach event listeners, schedule recovery timers. Extracted out of
 * the `init` action so it lives outside the `create()` closure and the action
 * itself can stay a thin idempotent wrapper that re-uses `initPromise`.
 */
type StoreGet = () => AppState;
type StoreSet = (
  partial:
    | Partial<AppState>
    | ((state: AppState) => Partial<AppState>),
) => void;

async function doInit(get: StoreGet, set: StoreSet): Promise<void> {
  // Bind the workspace store's mutations to our persistence path so every
  // entity (skills, mcp, rules, agents, tasks, chats, logs) writes through here.
  bindWorkspacePersist(() => get().persist());
  bindGlobalErrorLogging();

  const persisted = await loadPersisted();
  if (persisted) {
    set({
      keys: persisted.keys,
      settings: persisted.settings,
      activeKeyId: persisted.activeKeyId,
    });
    useThemeStore.getState().setTheme(persisted.theme);
    useWorkspaceStore.getState().hydrate({
      skills: persisted.skills,
      mcpServers: persisted.mcpServers,
      rules: persisted.rules,
      agents: persisted.agents,
      tasks: persisted.tasks,
      chats: persisted.chats,
      logs: persisted.logs,
    });
  }

  // Ensure we always have a proxy token — generate one the very first run
  // (or after an old persisted state from before the proxy-key feature).
  if (!get().settings.proxyKey) {
    const fresh = generateProxyKey();
    set((s) => ({ settings: { ...s.settings, proxyKey: fresh } }));
    savePersisted(snapshot(get()));
  }

  set({ ready: true });
  // Probe environment & config in the background.
  get().refreshEnv();
  get().refreshClaudeConfig();
  if (get().settings.monitorIntervalSec > 0) get().startMonitor();
  setDesktopNotifications(get().settings.desktopNotifications);
  get().startActiveWatch();

  // Live key-switch events from the proxy (Rust side). Only success ("ok"
  // status hint) avoids being logged — every other outcome is a real failure
  // the user wants to see in the Logs view.
  onProxySwitch((e) => {
    const patch: Partial<ApiKey> = {
      status: e.statusHint,
      lastMessage: `代理切换 (HTTP ${e.httpStatus})`,
      httpStatus: e.httpStatus,
    };
    if (e.statusHint === "cooling") {
      patch.cooldownUntil = new Date(
        Date.now() + e.cooldownSecs * 1000,
      ).toISOString();
    }
    get().updateKey(e.fromId, patch);

    const wsLog = useWorkspaceStore.getState().log;
    const isFailure = e.httpStatus >= 400;
    const failureLevel: "warning" | "error" =
      e.httpStatus === 401 || e.httpStatus === 403 ? "error" : "warning";

    if (e.toId) {
      const switching = e.toId !== get().activeKeyId;
      set({ activeKeyId: e.toId });
      get().persist();
      if (isFailure) {
        wsLog(
          failureLevel,
          "proxy",
          `HTTP ${e.httpStatus} → ${e.toName ?? e.toId}`,
        );
      }
      const tripped = recordRotation(e.toId, !isFailure);
      if (tripped) {
        wsLog(
          "error",
          "proxy",
          `所有密钥均失败 (≥${SWEEP_KEY_THRESHOLD} 个连续失败)。已暂停自动轮换。`,
          "请检查上游网关或第三方账号状态后，在「设置」中重新开启或刷新密钥。",
        );
        get().updateSettings({ autoRotate: false });
        notify("error", t("toast.noUsable"), t("toast.noUsableDesc"), {
          desktopBody: t("notify.noUsableDesktop"),
        });
      } else if (switching && shouldEmitRotateNotice(e.toId)) {
        const name = e.toName ?? "";
        notify(
          "info",
          t("toast.autoRotated"),
          t("toast.rotatedToPlain", { name }),
          { desktopBody: t("proxy.switchedDesktop", { name }) },
        );
      }
    } else {
      wsLog("error", "proxy", `HTTP ${e.httpStatus} — no usable key`);
      if (shouldEmitRotateNotice(null)) {
        notify("error", t("toast.noUsable"), t("toast.noUsableDesc"), {
          desktopBody: t("notify.noUsableDesktop"),
        });
      }
    }
  });

  // Subscribe to throttled metric pushes from the proxy.
  onProxyMetrics((m) => set({ proxyStats: m }));

  // Always-on local proxy: start it; if the port is taken, surface a toast
  // and let the user pick a new one in Settings — the app stays usable.
  try {
    const port = await startProxy(
      get().settings.proxyPort || DEFAULT_PROXY_PORT,
    );
    await setProxyToken(get().settings.proxyKey);
    set({ proxyRunning: true });
    get().updateSettings({ proxyPort: port });
    get().syncProxyKeys();

    try {
      const cfg = await readClaudeConfig();
      const wanted = `http://127.0.0.1:${port}`;
      const wrongBase = (cfg.currentBaseUrl ?? "") !== wanted;
      const wrongToken = (cfg.currentKey ?? "") !== get().settings.proxyKey;
      if (wrongBase || wrongToken) {
        await migrateToProxy({
          port,
          token: get().settings.proxyKey,
          backup: get().settings.autoBackup,
        });
        await get().refreshClaudeConfig();
        if (cfg.exists && (cfg.currentKey || cfg.currentBaseUrl)) {
          notify("info", t("proxy.takeover"), t("proxy.takeoverDesc"));
        }
      } else {
        await get().refreshClaudeConfig();
      }
    } catch (e) {
      console.error("接管 Claude 配置失败", e);
    }
  } catch (e) {
    set({ proxyRunning: false });
    toast.error(t("proxy.startFailed"), String(e));
  }

  // Cooldown auto-recovery: once a key's cooldown elapses, return it to the
  // pool so it can be re-checked and re-used.
  if (!recoveryTimer) {
    recoveryTimer = setInterval(() => {
      const cooled = get().keys.filter(
        (k) =>
          k.status === "cooling" && cooldownRemaining(k.cooldownUntil) === 0,
      );
      for (const k of cooled) {
        get().updateKey(k.id, { status: "unknown", cooldownUntil: undefined });
      }
    }, 10_000);
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  view: "dashboard",
  keys: [],
  settings: DEFAULT_SETTINGS,
  activeKeyId: null,
  claudeEnv: null,
  claudeConfig: null,
  detecting: false,
  checking: {},
  bulkChecking: false,
  proxyRunning: false,
  proxyStats: EMPTY_METRICS,

  init: async () => {
    // StrictMode double-mounts effects in development; without this guard the
    // proxy event listeners get attached twice and every notification fires
    // twice. Idempotent — concurrent callers share the same promise.
    if (initPromise) return initPromise;
    initPromise = (async () => {
      await doInit(get, set);
    })();
    return initPromise;
  },

  persist: () => {
    savePersisted(snapshot(get()));
    // Keep the running proxy's pool in lock-step with any key/setting change.
    get().syncProxyKeys();
  },

  setView: (view) => set({ view }),

  refreshEnv: async () => {
    set({ detecting: true });
    try {
      const env = await detectClaude();
      set({ claudeEnv: env });
    } catch (e) {
      console.error(e);
    } finally {
      set({ detecting: false });
    }
  },

  refreshClaudeConfig: async () => {
    try {
      const cfg = await readClaudeConfig();
      set({ claudeConfig: cfg });
    } catch (e) {
      console.error(e);
    }
  },

  addKey: (input) => {
    const now = new Date().toISOString();
    const order = get().keys.reduce((m, k) => Math.max(m, k.order), 0) + 1;
    const key: ApiKey = {
      id: uid(),
      name: input.name,
      key: input.key,
      url: input.url,
      authField: input.authField ?? get().settings.defaultAuthField,
      note: input.note,
      enabled: input.enabled ?? true,
      status: "unknown",
      createdAt: now,
      order,
    };
    set((s) => ({ keys: [...s.keys, key] }));
    get().persist();
    return key;
  },

  updateKey: (id, patch) => {
    set((s) => ({
      keys: s.keys.map((k) => (k.id === id ? { ...k, ...patch } : k)),
    }));
    get().persist();
  },

  removeKey: (id) => {
    const wasActive = get().activeKeyId === id;
    set((s) => ({ keys: s.keys.filter((k) => k.id !== id) }));
    if (wasActive) set({ activeKeyId: null });
    get().persist();
    if (wasActive && get().settings.autoRotate) {
      get().rotateNext(t("reason.deleted"));
    }
  },

  removeKeys: (ids) => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const active = get().activeKeyId;
    const wasActive = active != null && idSet.has(active);
    set((s) => ({ keys: s.keys.filter((k) => !idSet.has(k.id)) }));
    if (wasActive) set({ activeKeyId: null });
    get().persist();
    if (wasActive && get().settings.autoRotate) {
      get().rotateNext(t("reason.deleted"));
    }
  },

  toggleKey: (id) => {
    set((s) => ({
      keys: s.keys.map((k) =>
        k.id === id
          ? {
              ...k,
              enabled: !k.enabled,
              status: !k.enabled ? "unknown" : "disabled",
            }
          : k,
      ),
    }));
    get().persist();
    // If we just disabled the active key, rotate away.
    const k = get().keys.find((x) => x.id === id);
    if (k && !k.enabled && get().activeKeyId === id && get().settings.autoRotate) {
      get().rotateNext(t("reason.disabled"));
    }
  },

  importKeys: (rows) => {
    const valid = rows.filter((r) => r.selected && r.valid && r.key);
    if (valid.length === 0) return 0;
    const existing = new Set(get().keys.map((k) => k.key));
    let order = get().keys.reduce((m, k) => Math.max(m, k.order), 0);
    const now = new Date().toISOString();
    const additions: ApiKey[] = [];
    for (const r of valid) {
      if (existing.has(r.key)) continue;
      existing.add(r.key);
      order += 1;
      additions.push({
        id: uid(),
        name: r.name || t("import.defaultName", { n: order }),
        key: r.key,
        url: r.url,
        authField: get().settings.defaultAuthField,
        note: r.note,
        enabled: true,
        status: "unknown",
        createdAt: now,
        order,
      });
    }
    if (additions.length === 0) return 0;
    set((s) => ({ keys: [...s.keys, ...additions] }));
    get().persist();
    return additions.length;
  },

  reorderKeys: (orderedIds) => {
    set((s) => ({
      keys: s.keys.map((k) => {
        const idx = orderedIds.indexOf(k.id);
        return idx >= 0 ? { ...k, order: idx + 1 } : k;
      }),
    }));
    get().persist();
  },

  setActiveKey: async (id, opts) => {
    const key = get().keys.find((k) => k.id === id);
    if (!key) return;
    set({ activeKeyId: id });
    get().persist();
    // Note: activateKeyInClaude only ever writes the proxy URL + proxy
    // token into Claude's settings.json — the real key stays in our store.
    try {
      await activateKeyInClaude(key, get().settings);
      get().refreshClaudeConfig();
      if (!opts?.silent) {
        toast.success(t("toast.switched"), t("toast.switchedTo", { name: key.name }));
      }
    } catch (e) {
      toast.error(t("toast.writeFailed"), String(e));
    }
  },

  rotateNext: async (reason) => {
    const { keys, activeKeyId, settings } = get();
    const next = pickNext(keys, activeKeyId, settings.rotationStrategy);
    if (!next) {
      if (shouldEmitRotateNotice(null)) {
        notify("error", t("toast.noUsable"), t("toast.noUsableDesc"), {
          desktopBody: t("notify.noUsableDesktop"),
        });
      }
      return false;
    }
    if (next.id === activeKeyId) return false;
    await get().setActiveKey(next.id, { silent: true });
    if (shouldEmitRotateNotice(next.id)) {
      const detail = reason
        ? t("toast.rotatedTo", { reason, name: next.name })
        : t("toast.rotatedToPlain", { name: next.name });
      notify("info", t("toast.autoRotated"), detail, {
        desktopBody: t("notify.rotatedDesktop", { name: next.name }),
      });
    }
    return true;
  },

  syncProxyKeys: () => {
    if (!get().proxyRunning) return;
    const { keys, activeKeyId, settings } = get();
    const base = settings.defaultBaseUrl || DEFAULT_BASE_URL;
    const pool = rankForProxy(keys, settings.rotationStrategy, activeKeyId).map((k) => ({
      id: k.id,
      name: k.name,
      key: k.key,
      url: k.url || base,
      authField: k.authField,
    }));
    setProxyKeys(pool, base, activeKeyId).catch((e) => console.error("同步代理密钥失败", e));
  },

  restartProxy: async (port) => {
    // Stop, rebind on the new port, then re-attach state.
    try {
      await stopProxy();
    } catch (e) {
      console.error(e);
    }
    set({ proxyRunning: false });
    try {
      const bound = await startProxy(port);
      await setProxyToken(get().settings.proxyKey);
      set({ proxyRunning: true });
      get().updateSettings({ proxyPort: bound });
      get().syncProxyKeys();
      await migrateToProxy({
        port: bound,
        token: get().settings.proxyKey,
        backup: get().settings.autoBackup,
      });
      await get().refreshClaudeConfig();
      toast.success(t("proxy.restarted"), t("proxy.restartedDesc", { port: bound }));
    } catch (e) {
      toast.error(t("proxy.startFailed"), String(e));
    }
  },

  regenerateProxyKey: async () => {
    const fresh = generateProxyKey();
    get().updateSettings({ proxyKey: fresh });
    try {
      await setProxyToken(fresh);
      await migrateToProxy({
        port: get().settings.proxyPort,
        token: fresh,
        backup: get().settings.autoBackup,
      });
      await get().refreshClaudeConfig();
      toast.success(t("proxy.keyRegenerated"), t("proxy.keyRegeneratedDesc"));
    } catch (e) {
      toast.error(t("proxy.keyRegenerateFailed"), String(e));
    }
  },

  refreshProxyStats: async () => {
    try {
      const m = await fetchProxyMetrics();
      set({ proxyStats: m });
    } catch (e) {
      console.error(e);
    }
  },

  checkKey: async (id) => {
    const key = get().keys.find((k) => k.id === id);
    if (!key || !key.enabled) return;
    // Avoid overlapping probes of the same key (full monitor vs active watch).
    if (get().checking[id]) return;
    const prevStatus = key.status;
    set((s) => ({ checking: { ...s.checking, [id]: true } }));
    try {
      const result = await probeKey(key, get().settings);
      const derived = deriveStatus(key, result, get().settings);

      const patch: Partial<ApiKey> = {
        status: derived.status as KeyStatus,
        lastCheckedAt: result.checkedAt,
        lastMessage: derived.message,
        latencyMs: derived.latencyMs,
        httpStatus: derived.httpStatus,
        cooldownUntil: derived.cooldownUntil,
      };

      // Best-effort real USD quota query against the relay billing endpoints.
      if (get().settings.quotaQueryEnabled) {
        try {
          const q = await queryQuota(key, get().settings);
          patch.quotaSupported = q.supported;
          patch.quotaSource = q.source;
          patch.quotaCheckedAt = q.checkedAt;
          if (q.supported) {
            patch.quotaLimit = q.totalUsd ?? undefined;
            patch.quotaUsed = q.usedUsd ?? undefined;
            patch.quotaRemainingUsd = q.remainingUsd ?? undefined;
            patch.quotaRemainingPct = q.remainingPct ?? undefined;
            // Refine status using the fresh quota figure.
            if (
              patch.status === "active" &&
              typeof q.remainingPct === "number" &&
              q.remainingPct <= get().settings.quotaWarnThreshold
            ) {
              patch.status = q.remainingPct <= 0 ? "exhausted" : "low";
            }
          }
        } catch (e) {
          console.error("额度查询失败", e);
        }
      }

      get().updateKey(id, patch);

      // Native popups on meaningful status *transitions* only (not every poll,
      // so a key that stays "low"/"invalid" doesn't re-notify each sweep).
      const newStatus = patch.status as KeyStatus;
      if (newStatus !== prevStatus) {
        if (newStatus === "invalid") {
          notify(
            "error",
            t("notify.invalidKey"),
            t("notify.invalidKeyBody", { name: key.name }),
          );
        } else if (newStatus === "low") {
          const pct =
            patch.quotaRemainingPct ??
            key.quotaRemainingPct ??
            get().settings.quotaWarnThreshold;
          notify(
            "warning",
            t("notify.lowQuota"),
            t("notify.lowQuotaBody", { name: key.name, pct: Math.round(pct) }),
          );
        }
      }

      // React to the active key's new state. Runtime failover for in-flight
      // requests is the proxy's job (it already retried). Here we just advance
      // the *displayed* active key off a dead one and let the pool re-sync.
      const hardFail = ["cooling", "exhausted", "invalid"].includes(
        patch.status as string,
      );
      if (id === get().activeKeyId && hardFail) {
        const best = pickBest(get().keys, get().settings.rotationStrategy, id);
        if (best) {
          set({ activeKeyId: best.id });
          get().persist();
        }
      }
    } catch (e) {
      console.error(e);
    } finally {
      set((s) => {
        const next = { ...s.checking };
        delete next[id];
        return { checking: next };
      });
    }
  },

  checkAll: async (opts) => {
    const manual = opts?.manual !== false;
    if (manual && get().bulkChecking) return;
    const ids = get().keys.filter((k) => k.enabled).map((k) => k.id);
    if (manual) set({ bulkChecking: true });
    try {
      // limited concurrency
      const limit = 4;
      for (let i = 0; i < ids.length; i += limit) {
        await Promise.all(ids.slice(i, i + limit).map((id) => get().checkKey(id)));
      }
    } finally {
      if (manual) set({ bulkChecking: false });
    }
  },

  setQuota: (id, used, limit) => {
    get().updateKey(id, {
      quotaUsed: used,
      quotaLimit: limit,
      quotaRemainingPct: quotaPct(used, limit),
    });
  },

  startMonitor: () => {
    get().stopMonitor();
    const sec = get().settings.monitorIntervalSec;
    if (sec <= 0) return;
    monitorTimer = setInterval(() => {
      get().checkAll({ manual: false });
    }, sec * 1000);
  },

  stopMonitor: () => {
    if (monitorTimer) {
      clearInterval(monitorTimer);
      monitorTimer = null;
    }
  },

  startActiveWatch: () => {
    get().stopActiveWatch();
    const sec = get().settings.activeWatchSec;
    if (sec <= 0) return;
    activeWatchTimer = setInterval(() => {
      const id = get().activeKeyId;
      if (id) get().checkKey(id);
    }, sec * 1000);
  },

  stopActiveWatch: () => {
    if (activeWatchTimer) {
      clearInterval(activeWatchTimer);
      activeWatchTimer = null;
    }
  },

  updateSettings: (patch) => {
    const prev = get().settings;
    const settings = { ...prev, ...patch };
    set({ settings });
    get().persist();
    if (
      patch.monitorIntervalSec !== undefined &&
      patch.monitorIntervalSec !== prev.monitorIntervalSec
    ) {
      if (settings.monitorIntervalSec > 0) get().startMonitor();
      else get().stopMonitor();
    }
    if (patch.desktopNotifications !== undefined) {
      setDesktopNotifications(settings.desktopNotifications);
    }
    if (
      patch.activeWatchSec !== undefined &&
      patch.activeWatchSec !== prev.activeWatchSec
    ) {
      get().startActiveWatch(); // restarts; self-stops when <= 0
    }
    // Propagate proxy-credential edits to the running proxy without forcing
    // a full restart (only port changes need that, which goes through
    // restartProxy explicitly).
    if (patch.proxyKey !== undefined && patch.proxyKey !== prev.proxyKey) {
      setProxyToken(patch.proxyKey).catch((e) =>
        console.error("更新代理 token 失败", e),
      );
    }
  },

  completeOnboarding: (patch) => {
    get().updateSettings({ ...patch, onboarded: true });
    // Promote the best available key to active right away.
    const best = pickBest(get().keys, get().settings.rotationStrategy);
    if (best && !get().activeKeyId) {
      get().setActiveKey(best.id, { silent: true });
    }
  },
}));

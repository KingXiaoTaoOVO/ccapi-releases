import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  BackupEntry,
  ClaudeConfig,
  ClaudeEnvInfo,
  InstallDone,
  InstallLog,
  KeyCheckResult,
  QuotaInfo,
} from "@/types";

/**
 * Thin, fully-typed wrappers around the Rust commands. Components/services
 * never call `invoke` directly — they go through here.
 */

// ----- environment & install -----
export const detectClaude = () => invoke<ClaudeEnvInfo>("detect_claude");

export const installClaude = (method: string) =>
  invoke<void>("install_claude", { method });

export const cancelInstall = () => invoke<void>("cancel_install");

export const onInstallLog = (cb: (log: InstallLog) => void): Promise<UnlistenFn> =>
  listen<InstallLog>("install://log", (e) => cb(e.payload));

export const onInstallDone = (cb: (done: InstallDone) => void): Promise<UnlistenFn> =>
  listen<InstallDone>("install://done", (e) => cb(e.payload));

// ----- system tray quick actions -----
export type TrayAction = "nav:dashboard" | "nav:settings" | "rotate" | "checkAll";

export const onTrayAction = (cb: (action: TrayAction) => void): Promise<UnlistenFn> =>
  listen<TrayAction>("tray://action", (e) => cb(e.payload));

// ----- claude config takeover -----
export const readClaudeConfig = () => invoke<ClaudeConfig>("read_claude_config");

export const applyKeyToConfig = (args: {
  key: string;
  baseUrl?: string | null;
  authField?: string | null;
  backup: boolean;
}) =>
  invoke<string>("apply_key_to_config", {
    key: args.key,
    baseUrl: args.baseUrl ?? null,
    authField: args.authField ?? null,
    backup: args.backup,
  });

export const backupConfig = () => invoke<string>("backup_config");
export const listBackups = () => invoke<BackupEntry[]>("list_backups");
export const restoreConfig = (fileName: string) =>
  invoke<string>("restore_config", { fileName });

/**
 * Point Claude Code's settings.json at the local proxy. Always writes the
 * proxy URL + proxy token (Bearer) — never a real third-party credential.
 */
export const migrateToProxy = (args: {
  port: number;
  token: string;
  backup: boolean;
}) =>
  invoke<string>("migrate_to_proxy", {
    port: args.port,
    token: args.token,
    backup: args.backup,
  });

// ----- caches / cleanup -----
export interface ClearReport {
  backupsRemoved: number;
  logsRemoved: number;
  bytesReclaimed: number;
}
export const clearAppCaches = () => invoke<ClearReport>("clear_app_caches");

// ----- app state persistence -----
export const loadAppState = () => invoke<string | null>("load_app_state");
export const saveAppState = (data: string) => invoke<void>("save_app_state", { data });

// ----- import -----
export const readTextFile = (path: string) =>
  invoke<string>("read_text_file", { path });

// ----- monitoring -----
export const checkKeyStatus = (args: {
  key: string;
  baseUrl?: string | null;
  authField?: string | null;
  model?: string | null;
  timeoutMs?: number | null;
}) =>
  invoke<KeyCheckResult>("check_key_status", {
    key: args.key,
    baseUrl: args.baseUrl ?? null,
    authField: args.authField ?? null,
    model: args.model ?? null,
    timeoutMs: args.timeoutMs ?? null,
  });

export const queryKeyQuota = (args: {
  key: string;
  baseUrl?: string | null;
  timeoutMs?: number | null;
}) =>
  invoke<QuotaInfo>("query_key_quota", {
    key: args.key,
    baseUrl: args.baseUrl ?? null,
    timeoutMs: args.timeoutMs ?? null,
  });

// ----- native OS notifications -----
/** Show a native system notification (Windows toast / macOS / Linux). */
export const notifySystem = (title: string, body: string) =>
  invoke<void>("notify_system", { title, body });

// ----- seamless proxy -----
export interface ProxyKeyInput {
  id: string;
  name: string;
  key: string;
  url?: string | null;
  authField?: string | null;
}

export interface ProxyStatus {
  running: boolean;
  port: number;
  poolSize: number;
}

export interface ProxySwitchEvent {
  fromId: string;
  fromName: string;
  toId: string | null;
  toName: string | null;
  httpStatus: number;
  /** how the failed key should now be marked */
  statusHint: "cooling" | "exhausted" | "invalid";
  cooldownSecs: number;
}

export interface ProxyFailure {
  id: string;
  name: string;
  count: number;
}

export interface ProxyMetrics {
  running: boolean;
  port: number;
  poolSize: number;
  totalForwarded: number;
  currentHitId: string | null;
  currentHitName: string | null;
  failures: ProxyFailure[];
}

export const startProxy = (port: number) => invoke<number>("start_proxy", { port });
export const stopProxy = () => invoke<void>("stop_proxy");
export const proxyStatus = () => invoke<ProxyStatus>("proxy_status");
export const proxyMetrics = () => invoke<ProxyMetrics>("proxy_metrics");
export const setProxyKeys = (
  keys: ProxyKeyInput[],
  defaultBaseUrl: string,
  activeId: string | null,
) => invoke<void>("set_proxy_keys", { keys, defaultBaseUrl, activeId });
export const setProxyToken = (token: string) =>
  invoke<void>("set_proxy_token", { token });
export const checkPortAvailable = (port: number) =>
  invoke<boolean>("check_port_available", { port });

export const onProxySwitch = (
  cb: (e: ProxySwitchEvent) => void,
): Promise<UnlistenFn> =>
  listen<ProxySwitchEvent>("proxy://switch", (e) => cb(e.payload));

export const onProxyMetrics = (
  cb: (m: ProxyMetrics) => void,
): Promise<UnlistenFn> =>
  listen<ProxyMetrics>("proxy://metrics", (e) => cb(e.payload));

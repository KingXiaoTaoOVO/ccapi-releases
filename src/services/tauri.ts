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
  UninstallOptions,
  UninstallReport,
} from "@/types";
import type {
  InitReport,
  ModeState,
  MysqlConfig,
  RedisConfig,
  RemoteHealth,
  ServerLocalConfig,
  ServerStatus,
} from "@/types/auth";

/**
 * Thin, fully-typed wrappers around the Rust commands. Components/services
 * never call `invoke` directly — they go through here.
 */

// ----- environment & install -----
export const detectClaude = () => invoke<ClaudeEnvInfo>("detect_claude");

export const installClaude = (method: string) =>
  invoke<void>("install_claude", { method });

/** Auto-pick the best available package manager and run the install.
 *  Resolves to the actually chosen method id ("bun" | "pnpm" | "npm" | "yarn" | "native"). */
export const installClaudeSmart = () =>
  invoke<string>("install_claude_smart");

// ----- avatar (本地存储) -----
export const saveUserAvatar = (args: {
  userId: number;
  mime: string;
  bytes: number[];
}) =>
  invoke<string>("save_user_avatar", {
    userId: args.userId,
    mime: args.mime,
    bytes: args.bytes,
  });

export const readUserAvatar = (userId: number) =>
  invoke<string | null>("read_user_avatar", { userId });

export const deleteUserAvatar = (userId: number) =>
  invoke<void>("delete_user_avatar", { userId });

export const cancelInstall = () => invoke<void>("cancel_install");

export const onInstallLog = (cb: (log: InstallLog) => void): Promise<UnlistenFn> =>
  listen<InstallLog>("install://log", (e) => cb(e.payload));

export const onInstallDone = (cb: (done: InstallDone) => void): Promise<UnlistenFn> =>
  listen<InstallDone>("install://done", (e) => cb(e.payload));

export const uninstallClaude = (opts: UninstallOptions) =>
  invoke<UninstallReport>("uninstall_claude", { opts });

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

/** 启用本地代理的"官方代理桥接"。传 null / 空字符串关闭。 */
export const setProxyOfficialMode = (args: {
  serverUrl: string | null;
  jwt: string | null;
}) =>
  invoke<void>("set_proxy_official_mode", {
    serverUrl: args.serverUrl,
    jwt: args.jwt,
  });

// ----- 一键配置外部 CLI -----
export interface CodexConfigReport {
  configPath: string;
  authPath: string;
  createdProvider: boolean;
  hadExistingConfig: boolean;
}

export const configureCodex = (args: {
  baseUrl: string;
  token: string;
  model?: string;
}) =>
  invoke<CodexConfigReport>("configure_codex", {
    baseUrl: args.baseUrl,
    token: args.token,
    model: args.model ?? null,
  });

export interface CodexCurrentConfig {
  configPath: string;
  configExists: boolean;
  modelProvider: string | null;
  ccapiBaseUrl: string | null;
  defaultModel: string | null;
}

export const readCodexConfig = () => invoke<CodexCurrentConfig>("read_codex_config");

/** 把 base_url + token 写入 ~/.claude/settings.json（Claude Code）。底层复用 apply_key_to_config。 */
export const configureClaudeCode = (args: {
  baseUrl: string;
  token: string;
  authField?: "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY";
}) =>
  invoke<string>("apply_key_to_config", {
    key: args.token,
    baseUrl: args.baseUrl,
    authField: args.authField ?? "ANTHROPIC_AUTH_TOKEN",
    backup: true,
  });

export const checkPortAvailable = (port: number) =>
  invoke<boolean>("check_port_available", { port });

export const setProxyActiveUser = (userId: number) =>
  invoke<void>("set_proxy_active_user", { userId });

/**
 * 直接探测某把 key 上游能提供的模型列表 —— 完全绕开本地代理 router，
 * 不会触发冷却 / 计费 / 失败计数。供 Chat / Playground / Agents 的
 * 模型下拉框「按 key 分组」动态填充。
 */
export const fetchModelsForKey = (args: {
  baseUrl: string | null;
  apiKey: string;
  authField?: "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY" | null;
}) =>
  invoke<string[]>("fetch_models_for_key", {
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
    authField: args.authField ?? null,
  });

export const onProxySwitch = (
  cb: (e: ProxySwitchEvent) => void,
): Promise<UnlistenFn> =>
  listen<ProxySwitchEvent>("proxy://switch", (e) => cb(e.payload));

export const onProxyMetrics = (
  cb: (m: ProxyMetrics) => void,
): Promise<UnlistenFn> =>
  listen<ProxyMetrics>("proxy://metrics", (e) => cb(e.payload));

// ============================================================================
// 服务端 / 客户端模式（Phase 1+）
// ============================================================================

export const getMode = () => invoke<ModeState>("get_mode");
export const setMode = (state: ModeState) =>
  invoke<void>("set_mode", { state });

export const readServerLocalConfig = () =>
  invoke<ServerLocalConfig>("read_server_local_config");
export const writeServerLocalConfig = (cfg: ServerLocalConfig) =>
  invoke<void>("write_server_local_config", { cfg });
export const verifyEntryPassword = (password: string) =>
  invoke<boolean>("verify_entry_password", { password });
export const changeEntryPassword = (oldPassword: string, newPassword: string) =>
  invoke<void>("change_entry_password", { oldPassword, newPassword });

export const testMysqlConnection = (cfg: MysqlConfig) =>
  invoke<void>("test_mysql_connection", { cfg });
export const testRedisConnection = (cfg: RedisConfig) =>
  invoke<void>("test_redis_connection", { cfg });
export const initDatabase = () => invoke<InitReport>("init_database");
export const resetDatabase = () => invoke<InitReport>("reset_database");

export const startAdminServer = () =>
  invoke<ServerStatus>("start_admin_server");
export const stopAdminServer = () => invoke<void>("stop_admin_server");
export const adminServerStatus = () =>
  invoke<ServerStatus>("admin_server_status");

export const probeRemoteServer = (url: string) =>
  invoke<RemoteHealth>("probe_remote_server", { url });

export const openClientWindow = () =>
  invoke<void>("open_client_window");

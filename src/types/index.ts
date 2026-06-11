// ============================================================
// CCAPI — shared TypeScript types
// ============================================================

import type { MessageKey } from "@/i18n/messages";

export type Theme = "light" | "dark" | "system";

export type AuthField = "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY";

export type RotationStrategy = "sequential" | "quota" | "latency";

/**
 * Lifecycle status of an API key.
 * - active:    正常可用
 * - low:       额度不足（低于阈值）
 * - exhausted: 额度耗尽
 * - cooling:   冷却中 / 被限流
 * - disabled:  已禁用（不参与轮换）
 * - invalid:   密钥无效
 * - unknown:   尚未检测
 */
export type KeyStatus =
  | "active"
  | "low"
  | "exhausted"
  | "cooling"
  | "disabled"
  | "invalid"
  | "unknown";

export interface ApiKey {
  id: string;
  name: string;
  key: string;
  /** Custom API base URL; empty → Claude official endpoint. */
  url?: string;
  authField: AuthField;
  note?: string;
  enabled: boolean;
  status: KeyStatus;

  // monitoring snapshot
  lastCheckedAt?: string;
  lastMessage?: string;
  latencyMs?: number;
  httpStatus?: number;

  // quota (queried from relay billing endpoints, best-effort)
  quotaLimit?: number;
  quotaUsed?: number;
  quotaRemainingUsd?: number;
  /** 0..100 when known. */
  quotaRemainingPct?: number;
  quotaSupported?: boolean;
  quotaSource?: string;
  quotaCheckedAt?: string;

  // cooling
  cooldownUntil?: string;

  createdAt: string;
  order: number;
}

export interface AppSettings {
  requestTimeoutMs: number;
  /** Percent (0..100). Below this the key is flagged "low" and rotation kicks in. */
  quotaWarnThreshold: number;
  rotationStrategy: RotationStrategy;
  autoRotate: boolean;
  /** Preferred local port for the proxy. Start fails loudly if taken. */
  proxyPort: number;
  /**
   * The Bearer token Claude Code presents to the local proxy. Written into
   * `~/.claude/settings.json` as `ANTHROPIC_AUTH_TOKEN`; the proxy validates
   * incoming requests against it. Real third-party keys are NEVER written
   * into Claude's config.
   */
  proxyKey: string;
  autoBackup: boolean;
  /** Background monitor interval in seconds; 0 disables polling. */
  monitorIntervalSec: number;
  /**
   * Fast watchdog interval (seconds) that probes *only* the active key, so an
   * auth failure (401) on the live key is caught and rotated away within
   * seconds instead of waiting for the full monitor sweep. 0 disables it.
   */
  activeWatchSec: number;
  /** Fire native OS notifications (system popups) for important key events. */
  desktopNotifications: boolean;
  defaultBaseUrl: string;
  defaultAuthField: AuthField;
  testModel: string;
  /** Query relay billing endpoints for real USD quota during checks. */
  quotaQueryEnabled: boolean;
  onboarded: boolean;
  /** Run an updater check shortly after the app starts. */
  autoCheckUpdate: boolean;
  /** When `true`, found updates download + install without an extra prompt. */
  autoInstallUpdate: boolean;
  /** Launch CCAPI when the user signs into the OS. */
  autostart: boolean;

  // ===== Phase-2 UX 偏好（统一存到 settings 里） =====
  /** UI 缩放倍率：0.85 / 1 / 1.15 / 1.3 */
  uiScale?: number;
  /** 主体字号 (px)：12-18 */
  fontSize?: number;
  /** 关闭窗口时最小化到托盘而不是退出（默认 true） */
  minimizeToTray?: boolean;
  /** 高危操作是否始终弹出二次确认（即使有"7 天免再问"也忽略） */
  alwaysConfirmDangerous?: boolean;
  /** 自动重试次数（用户级，作用于 apiClient） */
  autoRetryCount?: number;
  /** 锁屏超时（秒），0 表示关闭 */
  lockTimeoutSecs?: number;
  /** 代理来源：local = 走本机出网；official = 走 CCAPI 服务端渠道（扣额度） */
  proxySource?: "local" | "official";

  /** 网络代理：影响所有出网请求 */
  networkProxy?: NetworkProxyConfig;

  /** 默认渠道 ID（0 = 自动智能路由）。仅持久化偏好，relay 消费在第 2 波。 */
  defaultChannelId?: number;
}

export interface NetworkProxyConfig {
  mode: "system" | "direct" | "http" | "socks5";
  /** 仅 http / socks5 模式使用，形如 "http://127.0.0.1:7890" */
  url?: string;
}

export interface QuotaInfo {
  supported: boolean;
  totalUsd: number | null;
  usedUsd: number | null;
  remainingUsd: number | null;
  remainingPct: number | null;
  currency: string;
  source: string;
  message: string;
  checkedAt: string;
}

/** A row produced by the batch importer before it is committed. */
export interface ImportedKey {
  id: string;
  name: string;
  key: string;
  url?: string;
  note?: string;
  valid: boolean;
  /** i18n key for the invalid reason (absent when valid). */
  reasonKey?: MessageKey;
  selected: boolean;
}

// ----- Backend (Rust) DTOs — keep in sync with src-tauri/src/models.rs -----

export interface PackageManager {
  name: string;
  available: boolean;
  version: string | null;
}

export interface ClaudeEnvInfo {
  installed: boolean;
  version: string | null;
  binaryPath: string | null;
  installMethod: string | null;
  configDir: string;
  configDirExists: boolean;
  settingsPath: string;
  settingsExists: boolean;
  legacyConfigPath: string;
  legacyConfigExists: boolean;
  packageManagers: PackageManager[];
  checkedPaths: string[];
}

export interface ClaudeConfig {
  settingsPath: string;
  exists: boolean;
  raw: string;
  currentKey: string | null;
  currentBaseUrl: string | null;
  currentAuthField: string | null;
}

export interface KeyCheckResult {
  ok: boolean;
  status: "active" | "cooling" | "invalid" | "exhausted" | "error";
  httpStatus: number | null;
  latencyMs: number;
  message: string;
  retryAfterSecs: number | null;
  checkedAt: string;
}

export interface BackupEntry {
  fileName: string;
  path: string;
  createdAt: string;
  size: number;
}

export interface InstallLog {
  stream: "stdout" | "stderr" | "system";
  line: string;
}

export interface InstallDone {
  success: boolean;
  code: number | null;
  message: string;
}

export interface UninstallOptions {
  removeGlobalPackage: boolean;
  removeNativeInstallDir: boolean;
  removeConfigDir: boolean;
  removeLegacyConfig: boolean;
  backupFirst: boolean;
  /** Kill running claude processes first. */
  killProcesses?: boolean;
  /** Windows only: HKCU\Software\Anthropic + Uninstall\Claude*. */
  cleanRegistry?: boolean;
  /** Windows only: strip claude-related segments from HKCU\Environment\Path. */
  cleanPathEnv?: boolean;
  /** Empty the OS recycle bin after deletions. */
  emptyRecycleBin?: boolean;
}

export interface UninstallStep {
  target: string;
  action: string;
  /** "ok" | "skipped" | "failed" */
  status: "ok" | "skipped" | "failed";
  detail?: string;
}

export interface UninstallReport {
  success: boolean;
  backupPath?: string;
  steps: UninstallStep[];
  bytesRemoved: number;
}

// ----- Workspace entities (Skills / MCP / Rules / Agents / Tasks / Chat) -----

/** Reusable prompt fragment a user can inject into chats or attach to agents. */
export interface Skill {
  id: string;
  name: string;
  description?: string;
  /** Free-form markdown/instruction body. */
  body: string;
  /** Comma-free tag list for grouping. */
  tags: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type McpTransport = "stdio" | "http" | "sse";

/** External Model-Context-Protocol server registration. */
export interface McpServer {
  id: string;
  name: string;
  description?: string;
  transport: McpTransport;
  /** stdio: shell command; http/sse: URL */
  endpoint: string;
  /** Optional CLI args (stdio only). */
  args: string[];
  /** Optional environment variables (stdio only). */
  env: Record<string, string>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type RuleScope = "global" | "project" | "personal";

/** Behavior rule injected into the system prompt. */
export interface Rule {
  id: string;
  name: string;
  scope: RuleScope;
  body: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type AgentSandbox = "readOnly" | "workspaceWrite" | "fullAccess";
export type AgentApproval = "askEveryTime" | "onDemand" | "neverAsk";

/** User-built agent (system prompt + tool access + sandbox profile). */
export interface Agent {
  id: string;
  name: string;
  role: string;
  description?: string;
  systemPrompt: string;
  model: string;
  sandbox: AgentSandbox;
  approval: AgentApproval;
  networkAccess: boolean;
  /** Skill ids referenced by this agent. */
  skillIds: string[];
  /** MCP server ids referenced by this agent. */
  mcpIds: string[];
  /** Rule ids referenced by this agent. */
  ruleIds: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type AgentTaskKind = "ask" | "code" | "review" | "test" | "refactor";
export type AgentTaskStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

/** A single execution record for an agent task. */
export interface AgentTask {
  id: string;
  agentId: string | null;
  kind: AgentTaskKind;
  prompt: string;
  status: AgentTaskStatus;
  createdAt: string;
  finishedAt?: string;
  /** Last log line / outcome summary. */
  summary?: string;
}

export type ChatRole = "user" | "assistant" | "system";
export type ChatMode = "ask" | "code";

/** 附件元数据：图片或文件，用 base64 data URL 携带二进制；非常大文件警告用户。 */
export interface ChatAttachment {
  id: string;
  name: string;
  /** MIME；图片 image/png 等 */
  mime: string;
  size: number;
  /** data:image/...;base64,... — 在前端预览/重新发送都直接用它 */
  dataUrl: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** 可选附件列表；图片在气泡里显示缩略图，其它文件显示徽章 */
  attachments?: ChatAttachment[];
  /** Wall-clock ISO timestamp. */
  createdAt: string;
}

export type ChatSession = {
  id: string;
  title: string;
  mode: ChatMode;
  agentId: string | null;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
};

export type LogLevel = "info" | "warning" | "error";

/** Persistent diagnostic log entry. */
export interface LogEntry {
  id: string;
  level: LogLevel;
  /** Short category tag — e.g. "proxy", "key", "monitor", "system". */
  source: string;
  message: string;
  /** Optional detail / stacktrace. */
  detail?: string;
  createdAt: string;
}

/** Persisted blob shape (state.json). */
export interface PersistedState {
  version: number;
  keys: ApiKey[];
  settings: AppSettings;
  activeKeyId: string | null;
  theme: Theme;
  skills: Skill[];
  mcpServers: McpServer[];
  rules: Rule[];
  agents: Agent[];
  tasks: AgentTask[];
  chats: ChatSession[];
  logs: LogEntry[];
}

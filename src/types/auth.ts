// ============================================================================
// 服务端 / 客户端模式相关类型（与 Rust 端 serde camelCase 对齐）
// ============================================================================

export type AppMode = "server" | "client";

export interface ModeState {
  mode: AppMode | null;
  serverUrl: string | null;
}

export interface MysqlConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface RedisConfig {
  host: string;
  port: number;
  password: string | null;
  username: string | null;
  db: number;
}

export interface ServerLocalConfig {
  mysql: MysqlConfig;
  redis: RedisConfig;
  listenIp: string;
  listenPort: number;
  entryPasswordHash: string;
  jwtSecret: string;
  initialized: boolean;
}

export interface ServerStatus {
  running: boolean;
  boundAddress: string | null;
  initialized: boolean;
}

export interface InitReport {
  statementsExecuted: number;
  adminSeeded: boolean;
}

export interface RemoteHealth {
  ok: boolean;
  service: string | null;
  version: string | null;
  latencyMs: number;
}

// ============================================================================
// 认证 / 会话
// ============================================================================

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  jti: string;
  accessExpiresIn: number;
  refreshExpiresIn: number;
}

export interface UserBrief {
  id: number;
  username: string;
  role: string;
  permissions: string[];
  mustChangePassword: boolean;
  email: string | null;
}

export interface AuthSession {
  tokens: TokenPair;
  user: UserBrief;
  /** 模式（server 模式登录后获得 admin，client 模式登录后获得 user） */
  scope: AppMode;
}

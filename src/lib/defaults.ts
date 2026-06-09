import type { AppSettings, AuthField } from "@/types";
import type { MessageKey } from "@/i18n/messages";

export const STORAGE_VERSION = 5;

export const DEFAULT_BASE_URL = "https://api.anthropic.com";

/** Default local port for the proxy. */
export const DEFAULT_PROXY_PORT = 31415;

const PROXY_KEY_PREFIX = "sk-ccapi-";
const PROXY_KEY_BODY_LEN = 48;
const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Generate a Bearer-style proxy key in `sk-ccapi-<48 base62>` shape — picked to
 * resemble Anthropic's own `sk-ant-` keys closely enough that Claude Code's
 * client-side validation accepts it without complaint.
 */
export function generateProxyKey(): string {
  const buf = new Uint8Array(PROXY_KEY_BODY_LEN);
  crypto.getRandomValues(buf);
  let body = "";
  for (let i = 0; i < PROXY_KEY_BODY_LEN; i++) {
    body += BASE62[buf[i] % BASE62.length];
  }
  return PROXY_KEY_PREFIX + body;
}

export const DEFAULT_SETTINGS: AppSettings = {
  requestTimeoutMs: 15000,
  quotaWarnThreshold: 10,
  rotationStrategy: "sequential",
  autoRotate: true,
  proxyPort: DEFAULT_PROXY_PORT,
  // Filled by the store on first init (or migration from old persisted state).
  proxyKey: "",
  autoBackup: true,
  monitorIntervalSec: 120,
  activeWatchSec: 20,
  desktopNotifications: true,
  defaultBaseUrl: DEFAULT_BASE_URL,
  defaultAuthField: "ANTHROPIC_AUTH_TOKEN",
  testModel: "claude-3-5-haiku-20241022",
  quotaQueryEnabled: true,
  onboarded: false,
  autoCheckUpdate: true,
  autoInstallUpdate: false,
  autostart: false,
};

export const AUTH_FIELD_OPTIONS: {
  value: AuthField;
  labelKey: MessageKey;
  hintKey: MessageKey;
}[] = [
  {
    value: "ANTHROPIC_AUTH_TOKEN",
    labelKey: "auth.token.label",
    hintKey: "auth.token.hint",
  },
  {
    value: "ANTHROPIC_API_KEY",
    labelKey: "auth.apikey.label",
    hintKey: "auth.apikey.hint",
  },
];

// Known key shapes:
//  - Official:  sk-ant-xxxxxxxx...
//  - Relay:     fe_oa_<hex>  /  <prefix>_<sub>_<hex>
//  - Generic:   a long opaque token
const RE_OFFICIAL = /^sk-ant-[A-Za-z0-9_-]{20,}$/;
const RE_RELAY = /^[A-Za-z]{2,8}_[A-Za-z0-9]{1,8}_[A-Fa-f0-9]{24,}$/;
const RE_GENERIC = /^[A-Za-z0-9_-]{32,}$/;

export type KeyKind = "official" | "relay" | "generic";

export interface KeyValidation {
  valid: boolean;
  /** i18n key for the failure reason (absent when valid). */
  reasonKey?: MessageKey;
  kind?: KeyKind;
}

/** Validate the *format* of a key (does not test it against the network). */
export function validateKeyFormat(raw: string): KeyValidation {
  const key = raw.trim();
  if (!key) return { valid: false, reasonKey: "valid.empty" };
  if (/\s/.test(key)) return { valid: false, reasonKey: "valid.whitespace" };
  if (key.length < 20) return { valid: false, reasonKey: "valid.tooShort" };
  if (RE_OFFICIAL.test(key)) return { valid: true, kind: "official" };
  if (RE_RELAY.test(key)) return { valid: true, kind: "relay" };
  if (RE_GENERIC.test(key)) return { valid: true, kind: "generic" };
  return { valid: false, reasonKey: "valid.unknown" };
}

/** i18n key for a key-kind label. */
export function kindKey(kind: KeyKind): MessageKey {
  return `kind.${kind}` as MessageKey;
}

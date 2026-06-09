import type { ApiKey, AppSettings, KeyCheckResult, KeyStatus, QuotaInfo } from "@/types";
import { DEFAULT_BASE_URL } from "@/lib/defaults";
import { checkKeyStatus, queryKeyQuota } from "./tauri";

/** Run a live health-check against a key using the current settings. */
export function probeKey(key: ApiKey, settings: AppSettings): Promise<KeyCheckResult> {
  return checkKeyStatus({
    key: key.key,
    baseUrl: key.url || settings.defaultBaseUrl || DEFAULT_BASE_URL,
    authField: key.authField,
    model: settings.testModel,
    timeoutMs: settings.requestTimeoutMs,
  });
}

/** Query real USD quota from the relay's billing endpoints (best-effort). */
export function queryQuota(key: ApiKey, settings: AppSettings): Promise<QuotaInfo> {
  return queryKeyQuota({
    key: key.key,
    baseUrl: key.url || settings.defaultBaseUrl || DEFAULT_BASE_URL,
    timeoutMs: settings.requestTimeoutMs,
  });
}

export interface DerivedStatus {
  status: KeyStatus;
  cooldownUntil?: string;
  message: string;
  latencyMs?: number;
  httpStatus?: number;
}

/**
 * Translate a raw check result into a key status, factoring in the quota
 * warning threshold and any retry-after cooldown.
 */
export function deriveStatus(
  key: ApiKey,
  result: KeyCheckResult,
  settings: AppSettings,
): DerivedStatus {
  const base = {
    message: result.message,
    latencyMs: result.latencyMs,
    httpStatus: result.httpStatus ?? undefined,
  };

  switch (result.status) {
    case "active": {
      const pct = key.quotaRemainingPct;
      if (typeof pct === "number" && pct <= settings.quotaWarnThreshold) {
        return { ...base, status: "low" };
      }
      return { ...base, status: "active" };
    }
    case "cooling": {
      const secs = result.retryAfterSecs ?? 60;
      const until = new Date(Date.now() + secs * 1000).toISOString();
      return { ...base, status: "cooling", cooldownUntil: until };
    }
    case "exhausted":
      return { ...base, status: "exhausted" };
    case "invalid":
      return { ...base, status: "invalid" };
    case "error":
    default:
      // Transient/unknown — don't clobber a previously-good status hard.
      return { ...base, status: "unknown" };
  }
}

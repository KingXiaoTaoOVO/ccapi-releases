import type { ApiKey, RotationStrategy } from "@/types";
import { cooldownRemaining } from "./format";

/** Whether a key may currently participate in automatic rotation. */
export function isUsable(k: ApiKey): boolean {
  if (!k.enabled) return false;
  if (k.status === "disabled" || k.status === "invalid" || k.status === "exhausted") {
    return false;
  }
  if (k.status === "cooling" && cooldownRemaining(k.cooldownUntil) > 0) {
    return false;
  }
  // active / low / unknown / cooling-but-expired
  return true;
}

export function usableKeys(keys: ApiKey[]): ApiKey[] {
  return keys.filter(isUsable);
}

/** Pick the single best key for a strategy, optionally excluding one id. */
export function pickBest(
  keys: ApiKey[],
  strategy: RotationStrategy,
  excludeId?: string | null,
): ApiKey | null {
  const pool = usableKeys(keys).filter((k) => k.id !== excludeId);
  if (pool.length === 0) return null;

  if (strategy === "quota") {
    return [...pool].sort(
      (a, b) => (b.quotaRemainingPct ?? 100) - (a.quotaRemainingPct ?? 100),
    )[0];
  }
  if (strategy === "latency") {
    return [...pool].sort(
      (a, b) => (a.latencyMs ?? Number.MAX_SAFE_INTEGER) - (b.latencyMs ?? Number.MAX_SAFE_INTEGER),
    )[0];
  }
  // sequential → lowest order wins
  return [...pool].sort((a, b) => a.order - b.order)[0];
}

/**
 * Pick the next key to switch *to*, given the currently active one.
 * For sequential strategy it walks the ordered ring; otherwise it defers to the
 * best candidate excluding the current key.
 */
export function pickNext(
  keys: ApiKey[],
  currentId: string | null,
  strategy: RotationStrategy,
): ApiKey | null {
  if (strategy === "sequential") {
    const sorted = [...keys].sort((a, b) => a.order - b.order);
    if (sorted.length === 0) return null;
    const idx = sorted.findIndex((k) => k.id === currentId);
    const start = idx >= 0 ? idx : -1;
    for (let step = 1; step <= sorted.length; step++) {
      const cand = sorted[(start + step + sorted.length) % sorted.length];
      if (cand && cand.id !== currentId && isUsable(cand)) return cand;
    }
    // fall back to the current key if it is still usable
    const cur = sorted.find((k) => k.id === currentId);
    return cur && isUsable(cur) ? cur : null;
  }

  return pickBest(keys, strategy, currentId) ?? pickBest(keys, strategy);
}

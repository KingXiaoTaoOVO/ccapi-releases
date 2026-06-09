import { t, useI18n } from "@/i18n";

/** Mask a secret, keeping a short readable prefix/suffix. */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 12) return key.slice(0, 3) + "••••";
  return `${key.slice(0, 7)}••••••••${key.slice(-4)}`;
}

/** Generate a reasonably unique id without external deps. */
export function uid(prefix = "key"): string {
  const rand = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `${prefix}_${time}${rand}`;
}

function locale(): string {
  return useI18n.getState().lang === "zh" ? "zh-CN" : "en-US";
}

/** Human-friendly relative time, localized. */
export function timeAgo(iso?: string): string {
  if (!iso) return t("common.never");
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diff = Date.now() - then;
  const sec = Math.floor(diff / 1000);
  if (sec < 5) return t("common.justNow");
  if (sec < 60) return t("time.secAgo", { n: sec });
  const min = Math.floor(sec / 60);
  if (min < 60) return t("time.minAgo", { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t("time.hrAgo", { n: hr });
  const day = Math.floor(hr / 24);
  return t("time.dayAgo", { n: day });
}

/** Format an ISO string as a local date-time. */
export function formatDateTime(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(locale(), { hour12: false });
}

/** Remaining cooldown in whole seconds, or 0 if expired/unset. */
export function cooldownRemaining(iso?: string): number {
  if (!iso) return 0;
  const end = new Date(iso).getTime();
  if (Number.isNaN(end)) return 0;
  return Math.max(0, Math.floor((end - Date.now()) / 1000));
}

/** "1m 20s" style compact duration from seconds. */
export function formatDuration(totalSec: number): string {
  if (totalSec <= 0) return "0s";
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

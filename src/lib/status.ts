import type { KeyStatus } from "@/types";
import type { MessageKey } from "@/i18n/messages";

export type Tone = "success" | "warning" | "danger" | "info" | "muted";

export interface StatusMeta {
  /** i18n key for the status label. */
  labelKey: MessageKey;
  tone: Tone;
}

/** UI metadata for each key status (i18n label key + semantic colour tone). */
export const STATUS_META: Record<KeyStatus, StatusMeta> = {
  active: { labelKey: "status.active", tone: "success" },
  low: { labelKey: "status.low", tone: "warning" },
  exhausted: { labelKey: "status.exhausted", tone: "danger" },
  cooling: { labelKey: "status.cooling", tone: "info" },
  disabled: { labelKey: "status.disabled", tone: "muted" },
  invalid: { labelKey: "status.invalid", tone: "danger" },
  unknown: { labelKey: "status.unknown", tone: "muted" },
};

/** Tailwind class fragments per tone (text / background / border / dot). */
export const TONE_CLASSES: Record<
  Tone,
  { text: string; bg: string; border: string; dot: string }
> = {
  success: {
    text: "text-success",
    bg: "bg-success/10",
    border: "border-success/30",
    dot: "bg-success",
  },
  warning: {
    text: "text-warning",
    bg: "bg-warning/10",
    border: "border-warning/30",
    dot: "bg-warning",
  },
  danger: {
    text: "text-danger",
    bg: "bg-danger/10",
    border: "border-danger/30",
    dot: "bg-danger",
  },
  info: {
    text: "text-info",
    bg: "bg-info/10",
    border: "border-info/30",
    dot: "bg-info",
  },
  muted: {
    text: "text-muted",
    bg: "bg-muted/10",
    border: "border-muted/25",
    dot: "bg-muted",
  },
};

/** The four high-level buckets the README asks the UI to surface. */
export const STATUS_GROUPS: { key: string; labelKey: MessageKey; members: KeyStatus[] }[] = [
  { key: "available", labelKey: "group.available", members: ["active"] },
  { key: "low", labelKey: "group.low", members: ["low", "exhausted"] },
  { key: "cooling", labelKey: "group.cooling", members: ["cooling"] },
  { key: "disabled", labelKey: "group.disabled", members: ["disabled", "invalid"] },
];

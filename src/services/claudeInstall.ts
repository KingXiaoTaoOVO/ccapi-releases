import type { ClaudeEnvInfo } from "@/types";
import type { MessageKey } from "@/i18n/messages";
import {
  cancelInstall,
  detectClaude,
  installClaude,
  onInstallDone,
  onInstallLog,
} from "./tauri";

export { detectClaude, installClaude, cancelInstall, onInstallLog, onInstallDone };

export interface InstallOption {
  method: string;
  /** Literal label (npm/bun/pnpm) or i18n key for translated labels. */
  label?: string;
  labelKey?: MessageKey;
  /** Literal command string, or i18n key for a translated description. */
  description?: string;
  descriptionKey?: MessageKey;
  available: boolean;
}

/** Build the list of install methods, marking which package managers exist. */
export function installOptions(env: ClaudeEnvInfo | null): InstallOption[] {
  const has = (name: string) =>
    env?.packageManagers.find((p) => p.name === name)?.available ?? false;

  return [
    {
      method: "npm",
      label: "npm",
      description: "npm install -g @anthropic-ai/claude-code",
      available: has("npm"),
    },
    {
      method: "bun",
      label: "bun",
      description: "bun add -g @anthropic-ai/claude-code",
      available: has("bun"),
    },
    {
      method: "pnpm",
      label: "pnpm",
      description: "pnpm add -g @anthropic-ai/claude-code",
      available: has("pnpm"),
    },
    {
      method: "native",
      labelKey: "install.method.native",
      descriptionKey: "install.method.native.desc",
      available: true,
    },
  ];
}

/** Pick a sensible default install method given what's available. */
export function recommendInstallMethod(env: ClaudeEnvInfo | null): string {
  const opts = installOptions(env);
  return opts.find((o) => o.available && o.method !== "native")?.method ?? "native";
}

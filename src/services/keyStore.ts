import type { PersistedState } from "@/types";
import { DEFAULT_SETTINGS, STORAGE_VERSION } from "@/lib/defaults";
import { loadAppState, saveAppState } from "./tauri";

/** Load and migrate persisted state from disk. Returns null on first run. */
export async function loadPersisted(): Promise<PersistedState | null> {
  const raw = await loadAppState();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    return {
      version: STORAGE_VERSION,
      keys: parsed.keys ?? [],
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
      activeKeyId: parsed.activeKeyId ?? null,
      theme: parsed.theme ?? "system",
      skills: parsed.skills ?? [],
      mcpServers: parsed.mcpServers ?? [],
      rules: parsed.rules ?? [],
      agents: parsed.agents ?? [],
      tasks: parsed.tasks ?? [],
      chats: parsed.chats ?? [],
      logs: parsed.logs ?? [],
    };
  } catch (e) {
    console.error("无法解析持久化状态，将重置:", e);
    return null;
  }
}

/** Persist state to disk (best-effort; errors are logged, not thrown to UI). */
export async function savePersisted(state: PersistedState): Promise<void> {
  try {
    await saveAppState(JSON.stringify(state));
  } catch (e) {
    console.error("保存状态失败:", e);
  }
}

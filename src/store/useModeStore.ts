import { create } from "zustand";

import { configureApiClient } from "@/services/apiClient";
import {
  getMode as getModeCmd,
  probeRemoteServer,
  setMode as setModeCmd,
} from "@/services/tauri";
import type { AppMode, ModeState } from "@/types/auth";

interface ModeStore {
  ready: boolean;
  mode: AppMode | null;
  serverUrl: string | null;
  /** 客户端：远程探活结果 */
  remoteOk: boolean | null;
  remoteLatencyMs: number | null;

  init: () => Promise<void>;
  selectMode: (mode: AppMode) => Promise<void>;
  setServerUrl: (url: string) => Promise<void>;
  probe: () => Promise<boolean>;
  reset: () => Promise<void>;
}

export const useModeStore = create<ModeStore>((set, get) => ({
  ready: false,
  mode: null,
  serverUrl: null,
  remoteOk: null,
  remoteLatencyMs: null,

  init: async () => {
    // 多窗口支持：如果 URL 带 ?window=client，强制走客户端模式（用于服务端打开
    // 的客户端测试窗口），不读 mode.json。
    const params = new URLSearchParams(window.location.search);
    if (params.get("window") === "client") {
      // 客户端测试窗口：本机服务端默认端口 8787（与 server.json 默认一致）
      const defaultUrl = "http://127.0.0.1:8787";
      configureApiClient({ baseUrl: defaultUrl });
      set({
        mode: "client",
        serverUrl: defaultUrl,
        ready: true,
      });
      // 立即探活
      void get().probe();
      return;
    }
    try {
      const s: ModeState = await getModeCmd();
      // 每次启动都默认到「模式选择」，不恢复上次的 mode（避免直接跳过选择步骤）。
      // 但保留 serverUrl 持久化（客户端模式下省去再次输入）。
      set({
        mode: null,
        serverUrl: s.serverUrl,
        ready: true,
      });
    } catch (e) {
      console.error(e);
      set({ ready: true });
    }
  },

  selectMode: async (mode) => {
    if (!isClientWindow()) {
      await setModeCmd({ mode, serverUrl: get().serverUrl });
    }
    set({ mode });
  },

  setServerUrl: async (url) => {
    const normalized = url.trim().replace(/\/+$/, "");
    if (!isClientWindow()) {
      await setModeCmd({ mode: get().mode, serverUrl: normalized });
    }
    set({ serverUrl: normalized });
    configureApiClient({ baseUrl: normalized });
  },

  probe: async () => {
    const url = get().serverUrl;
    if (!url) {
      set({ remoteOk: false, remoteLatencyMs: null });
      return false;
    }
    try {
      const r = await probeRemoteServer(url);
      set({ remoteOk: r.ok, remoteLatencyMs: r.latencyMs });
      return r.ok;
    } catch {
      set({ remoteOk: false, remoteLatencyMs: null });
      return false;
    }
  },

  reset: async () => {
    if (!isClientWindow()) {
      await setModeCmd({ mode: null, serverUrl: null });
    }
    set({ mode: null, serverUrl: null, remoteOk: null });
  },
}));

function isClientWindow(): boolean {
  return new URLSearchParams(window.location.search).get("window") === "client";
}

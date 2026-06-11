import { create } from "zustand";

import { apiGet } from "@/services/apiClient";

/**
 * "服务端配置驱动客户端 UI" 中心 store。
 *
 * 任何客户端 UI（侧栏品牌、Login 页 OAuth 按钮、忘记密码入口、VersionBadge
 * 检查更新的 GitHub repo 等）凡是 *跟着服务端走* 的内容，都从这个 store 读。
 *
 * 触发拉取：
 * - 应用启动 hydrate 完毕
 * - serverUrl 变化（用户切换对接的服务端）
 * - 也可以让组件手动 refetch
 *
 * 拉不到（服务端不可达）时退回 `null`，由各组件用兜底默认值。
 */

export interface ServerSiteInfo {
  name: string;
  logoUrl: string;
  icpRecord: string;
  footer: string;
  announcement: string;
  /** 检查更新走的 GitHub repo，形如 "owner/repo" */
  updateRepo: string;
}

export interface ServerRegisterPolicy {
  open: boolean;
  requireInviteCode: boolean;
  requireEmailVerify: boolean;
  captchaStrength: "off" | "easy" | "normal" | "strong";
}

export interface ServerSystemAdvanced {
  chatEnabled: boolean;
  drawEnabled: boolean;
  dashboardEnabled: boolean;
}

export interface ServerOAuthProvider {
  code: string;
  displayName: string;
}

export interface ServerInfo {
  site: Partial<ServerSiteInfo>;
  registerPolicy: Partial<ServerRegisterPolicy>;
  systemAdvanced: Partial<ServerSystemAdvanced>;
  /** 服务端 SMTP 是否启用（决定客户端是否显示 forgot password / 邮件验证码相关 UI） */
  mailEnabled: boolean;
  /** 已启用的 OAuth providers，客户端登录页据此渲染按钮 */
  oauthProviders: ServerOAuthProvider[];
  api: {
    version: string;
  };
}

interface State {
  info: ServerInfo | null;
  loading: boolean;
  /** 配套 serverUrl 的最后一次拉取时间戳；用来避免重复拉取 */
  lastFetchAt: number;
  fetchedFor: string | null;
  /** 主动拉取 */
  refresh: (serverUrl: string | null) => Promise<void>;
  /** 显式清空（登出/切换模式时调） */
  clear: () => void;
}

const FRESH_MS = 30_000;

export const useServerInfoStore = create<State>((set, get) => ({
  info: null,
  loading: false,
  lastFetchAt: 0,
  fetchedFor: null,

  refresh: async (serverUrl) => {
    if (!serverUrl) {
      set({ info: null, fetchedFor: null });
      return;
    }
    // 防抖：30s 内重复请求直接跳过
    const st = get();
    if (
      st.fetchedFor === serverUrl &&
      st.info &&
      Date.now() - st.lastFetchAt < FRESH_MS
    ) {
      return;
    }
    set({ loading: true });
    try {
      const r = await apiGet<ServerInfo>("/api/site/info", { auth: false });
      set({
        info: r,
        fetchedFor: serverUrl,
        lastFetchAt: Date.now(),
        loading: false,
      });
    } catch {
      set({ loading: false });
    }
  },

  clear: () => set({ info: null, fetchedFor: null, lastFetchAt: 0 }),
}));

/** 把当前 serverUrl 的 site_info 拉到 store 里（idempotent）。 */
export function syncServerInfo(serverUrl: string | null): void {
  void useServerInfoStore.getState().refresh(serverUrl);
}

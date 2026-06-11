import { create } from "zustand";

import { apiPost, configureApiClient } from "@/services/apiClient";
import { setProxyActiveUser } from "@/services/tauri";
import type { AppMode, AuthSession, TokenPair, UserBrief } from "@/types/auth";

const STORAGE_KEY = "ccapi.session";

/** 多窗口隔离：服务端打开的客户端窗口用 sessionStorage，避免和主窗口共享登录态。 */
function authStorage(): Storage {
  const isClientWindow =
    new URLSearchParams(window.location.search).get("window") === "client";
  return isClientWindow ? window.sessionStorage : window.localStorage;
}

export type LoginOutcome =
  | { kind: "ok"; user: UserBrief }
  | { kind: "needs2fa"; partialToken: string; username: string; scope: AppMode };

interface AuthStore {
  session: AuthSession | null;
  loading: boolean;
  error: string | null;

  hydrate: () => void;
  login: (
    username: string,
    password: string,
    opts?: { captchaId?: string; captchaAnswer?: string; scope?: AppMode },
  ) => Promise<LoginOutcome>;
  finish2fa: (
    partialToken: string,
    code: string,
    scope: AppMode,
  ) => Promise<UserBrief>;
  logout: () => Promise<void>;
  changePassword: (oldPassword: string, newPassword: string) => Promise<void>;
  refreshMe: () => Promise<void>;
  set: (s: AuthSession | null) => void;
}

function persist(s: AuthSession | null): void {
  try {
    const store = authStorage();
    if (s) {
      store.setItem(STORAGE_KEY, JSON.stringify(s));
    } else {
      store.removeItem(STORAGE_KEY);
    }
  } catch {
    /* ignore */
  }
}

export const useAuthStore = create<AuthStore>((set, get) => {
  // 让 apiClient 拿到当前 session
  configureApiClient({
    getSession: () => get().session,
    setSession: (s) => {
      persist(s);
      set({ session: s });
    },
  });

  return {
    session: null,
    loading: false,
    error: null,

    hydrate: () => {
      try {
        const raw = authStorage().getItem(STORAGE_KEY);
        if (!raw) return;
        const s = JSON.parse(raw) as AuthSession;
        set({ session: s });
      } catch {
        /* ignore */
      }
    },

    login: async (username, password, opts = {}) => {
      set({ loading: true, error: null });
      try {
        const body = await apiPost<{
          ok: true;
          requires2fa?: boolean;
          partialToken?: string;
          tokens?: TokenPair;
          user?: UserBrief;
        }>(
          "/api/login",
          {
            username,
            password,
            captchaId: opts.captchaId,
            captchaAnswer: opts.captchaAnswer,
          },
          { auth: false },
        );
        if (body.requires2fa && body.partialToken) {
          set({ loading: false });
          return {
            kind: "needs2fa",
            partialToken: body.partialToken,
            username,
            scope: opts.scope ?? "client",
          };
        }
        if (!body.tokens || !body.user) {
          throw new Error("login: unexpected server response");
        }
        const session: AuthSession = {
          tokens: body.tokens,
          user: body.user,
          scope: opts.scope ?? "client",
        };
        persist(session);
        set({ session, loading: false });
        if (session.scope === "client") {
          setProxyActiveUser(body.user.id).catch(() => {});
        }
        return { kind: "ok", user: body.user };
      } catch (e: any) {
        set({ loading: false, error: e?.message ?? String(e) });
        throw e;
      }
    },

    finish2fa: async (partialToken, code, scope) => {
      set({ loading: true, error: null });
      try {
        const body = await apiPost<{
          ok: true;
          tokens: TokenPair;
          user: UserBrief;
        }>("/api/2fa/login", { partialToken, code }, { auth: false });
        const session: AuthSession = {
          tokens: body.tokens,
          user: body.user,
          scope,
        };
        persist(session);
        set({ session, loading: false });
        if (session.scope === "client") {
          setProxyActiveUser(body.user.id).catch(() => {});
        }
        return body.user;
      } catch (e: any) {
        set({ loading: false, error: e?.message ?? String(e) });
        throw e;
      }
    },

    logout: async () => {
      try {
        await apiPost("/api/logout");
      } catch {
        /* ignore */
      }
      persist(null);
      set({ session: null });
      setProxyActiveUser(0).catch(() => {});
    },

    changePassword: async (oldPassword, newPassword) => {
      await apiPost("/api/change-password", { oldPassword, newPassword });
      const cur = get().session;
      if (cur) {
        const next: AuthSession = {
          ...cur,
          user: { ...cur.user, mustChangePassword: false },
        };
        persist(next);
        set({ session: next });
      }
    },

    refreshMe: async () => {
      try {
        const body = await apiPost<{ ok: true; user: UserBrief }>("/api/me");
        const cur = get().session;
        if (cur) {
          const next: AuthSession = { ...cur, user: body.user };
          persist(next);
          set({ session: next });
        }
      } catch {
        /* ignore */
      }
    },

    set: (s) => {
      persist(s);
      set({ session: s });
      if (s && s.scope === "client") {
        setProxyActiveUser(s.user.id).catch(() => {});
      } else if (!s) {
        setProxyActiveUser(0).catch(() => {});
      }
    },
  };
});

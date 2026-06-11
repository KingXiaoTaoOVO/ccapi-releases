// ============================================================================
// 统一的 HTTP API 客户端 —— 客户端模式用 fetch 打远程 URL；
// 服务端模式（管理员在本机）用 fetch 打本地 axum (127.0.0.1:port)。
// 自动附带 Authorization、自动处理 401 刷新 / 退出。
// ============================================================================

import type { AuthSession, TokenPair } from "@/types/auth";

interface ApiClientConfig {
  baseUrl: string | null;
  getSession: () => AuthSession | null;
  setSession: (s: AuthSession | null) => void;
}

let config: ApiClientConfig = {
  baseUrl: null,
  getSession: () => null,
  setSession: () => {},
};

export function configureApiClient(cfg: Partial<ApiClientConfig>): void {
  config = { ...config, ...cfg };
}

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function rawFetch(
  path: string,
  init: RequestInit,
  withAuth = true,
): Promise<Response> {
  const base = config.baseUrl?.replace(/\/+$/, "") ?? "";
  const url = path.startsWith("http") ? path : `${base}${path}`;
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  if (withAuth) {
    const s = config.getSession();
    if (s?.tokens.accessToken) {
      headers.set("Authorization", `Bearer ${s.tokens.accessToken}`);
    }
  }
  return fetch(url, { ...init, headers });
}

// Coalesce concurrent refreshes — if N requests 401 at once we must NOT call
// /api/refresh N times: the server rotates jti each call and revokes the old
// one, so only the first refresh wins and the rest get 401 → session wiped.
let pendingRefresh: Promise<TokenPair | null> | null = null;

async function doRefresh(): Promise<TokenPair | null> {
  const s = config.getSession();
  if (!s?.tokens.refreshToken) return null;
  const resp = await rawFetch(
    "/api/refresh",
    {
      method: "POST",
      body: JSON.stringify({ refreshToken: s.tokens.refreshToken }),
    },
    false,
  );
  if (!resp.ok) return null;
  const body = await resp.json();
  if (!body?.ok) return null;
  const next: AuthSession = { ...s, tokens: body.tokens as TokenPair };
  config.setSession(next);
  return body.tokens as TokenPair;
}

function refreshAccessToken(): Promise<TokenPair | null> {
  if (!pendingRefresh) {
    pendingRefresh = doRefresh().finally(() => {
      pendingRefresh = null;
    });
  }
  return pendingRefresh;
}

export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
  opts: { auth?: boolean; retryOn401?: boolean } = {},
): Promise<T> {
  const { auth = true, retryOn401 = true } = opts;
  let resp = await rawFetch(path, init, auth);
  if (resp.status === 401 && auth && retryOn401) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      resp = await rawFetch(path, init, true);
    } else {
      config.setSession(null);
    }
  }
  const text = await resp.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { message: text };
  }
  if (!resp.ok || (body && body.ok === false)) {
    const code = body?.code ?? "http_error";
    const message = body?.message ?? `HTTP ${resp.status}`;
    throw new ApiError(resp.status, code, message);
  }
  return body as T;
}

// 便捷封装
export const apiGet = <T = unknown>(path: string, opts?: { auth?: boolean }) =>
  apiFetch<T>(path, { method: "GET" }, opts);

export const apiPost = <T = unknown>(
  path: string,
  body?: unknown,
  opts?: { auth?: boolean },
) =>
  apiFetch<T>(
    path,
    {
      method: "POST",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
    opts,
  );

export const apiPatch = <T = unknown>(path: string, body?: unknown) =>
  apiFetch<T>(path, {
    method: "PATCH",
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

export const apiDelete = <T = unknown>(path: string) =>
  apiFetch<T>(path, { method: "DELETE" });

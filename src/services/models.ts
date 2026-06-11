import type { ApiKey } from "@/types";
import { fetchModelsForKey } from "@/services/tauri";

/**
 * 模型下拉框的动态来源 —— 替代所有写死的 FALLBACK_MODELS / MODEL_OPTIONS。
 *
 * 设计：
 * - official 模式 → 走 CCAPI 服务端 `/api/v1/models` 聚合（全平台模型）
 * - local 模式    → 对**每一把启用的 key** 直接探测它上游的 `/v1/models`，
 *                  按 key 名分组返回，下拉框里就能看到 "key A · claude-...,
 *                  key B · gpt-4o, ..." 这样的分组列表
 *
 * 本地探测走 `fetchModelsForKey` 这条独立的 Tauri 命令 —— 不经过本地代理
 * router，所以**不会**触发冷却 / 计费 / 失败计数 / 轮换通知。
 */

export interface ModelGroup {
  /** 来源标识：official 时是 "official"；local 时是 key.id */
  sourceId: string;
  /** 分组显示名：official 时是「官方代理」；local 时是 key.name */
  sourceName: string;
  /** 该来源能用的模型 id 列表 */
  models: string[];
  /** 探测失败时填入；UI 可显示为灰色 */
  error?: string;
}

export interface AvailableModels {
  /** 按来源分组的模型列表 —— 顺序保证：active key / official 在前 */
  groups: ModelGroup[];
  /** 扁平 unique 列表，供「兜底默认值」用 */
  flat: string[];
}

const EMPTY: AvailableModels = { groups: [], flat: [] };

interface OfficialOpts {
  source: "official";
  serverUrl: string | null;
  jwt: string | null;
}

interface LocalOpts {
  source: "local";
  keys: ApiKey[];
  activeKeyId: string | null;
}

export type FetchModelsOpts = OfficialOpts | LocalOpts;

/** 拉 CCAPI 服务端的 `/api/v1/models` —— 已经在后端聚合好。 */
async function fetchOfficial(
  serverUrl: string,
  jwt: string | null,
): Promise<string[]> {
  const base = serverUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {};
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
  const resp = await fetch(`${base}/api/v1/models`, { headers });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  const list = Array.isArray(data?.data) ? data.data : [];
  return list
    .map((m: { id?: string }) => m?.id)
    .filter((s: unknown): s is string => typeof s === "string" && s.length > 0);
}

/** 探测一把 key 上游的模型列表 —— 经 Rust 端直接 fetch，绕开本地代理。 */
async function fetchOneKey(k: ApiKey): Promise<string[]> {
  return fetchModelsForKey({
    baseUrl: k.url && k.url.trim() ? k.url.trim() : null,
    apiKey: k.key,
    authField: k.authField,
  });
}

export async function getAvailableModels(
  opts: FetchModelsOpts,
): Promise<AvailableModels> {
  if (opts.source === "official") {
    if (!opts.serverUrl) return EMPTY;
    try {
      const models = await fetchOfficial(opts.serverUrl, opts.jwt);
      return {
        groups: [{ sourceId: "official", sourceName: "官方代理", models }],
        flat: dedupKeepOrder(models),
      };
    } catch (e: unknown) {
      return {
        groups: [
          {
            sourceId: "official",
            sourceName: "官方代理",
            models: [],
            error: (e as Error)?.message ?? String(e),
          },
        ],
        flat: [],
      };
    }
  }

  // local 模式：逐 key 探测，所有 key 的模型合并去重显示
  // 只过滤 enabled=false / 没填 key 的，其它状态（cooling / low / invalid）都参与探测 ——
  // status 是上一次的代理转发结果，不代表 key 现在拉不到模型列表；让用户看到尽量全的列表
  const enabled = opts.keys.filter((k) => k.enabled && !!k.key);
  if (enabled.length === 0) return EMPTY;

  // 把 active 的 key 排到最前面 —— 它的模型会变成下拉框的默认选中项
  const sorted = [...enabled].sort((a, b) => {
    const ra = a.id === opts.activeKeyId ? 0 : 1;
    const rb = b.id === opts.activeKeyId ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return a.order - b.order;
  });

  // 并发探测；单 key 失败不影响整体
  const results = await Promise.all(
    sorted.map(async (k): Promise<ModelGroup> => {
      try {
        const models = await fetchOneKey(k);
        return { sourceId: k.id, sourceName: k.name, models };
      } catch (e: unknown) {
        return {
          sourceId: k.id,
          sourceName: k.name,
          models: [],
          error: (e as Error)?.message ?? String(e),
        };
      }
    }),
  );

  // 扁平列表：保留出现顺序（active key 的模型在前），去重
  const flat = dedupKeepOrder(results.flatMap((g) => g.models));
  return { groups: results, flat };
}

function dedupKeepOrder(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of arr) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

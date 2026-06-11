import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  FileText,
  Image as ImageIcon,
  MessageSquarePlus,
  Paperclip,
  Pencil,
  Send,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Select, type SelectOption } from "@/components/ui/Select";
import { EmptyState } from "@/components/workspace/EmptyState";
import { useT } from "@/i18n";
import type { ChatAttachment, ChatMode, ChatSession } from "@/types";
import type { MessageKey } from "@/i18n/messages";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import { useAppStore } from "@/store/useAppStore";
import { useAuthStore } from "@/store/useAuthStore";
import { useModeStore } from "@/store/useModeStore";
import { confirm } from "@/store/useConfirmStore";
import { prompt } from "@/store/usePromptStore";
import { toast } from "@/store/useToastStore";
import { uid } from "@/lib/format";
import { cn } from "@/lib/cn";
import { formatDateTime, timeAgo } from "@/lib/format";
import { getAvailableModels } from "@/services/models";

const ROLE_LABEL: Record<"user" | "assistant" | "system", MessageKey> = {
  user: "chat.role.user",
  assistant: "chat.role.assistant",
  system: "chat.role.system",
};

function sessionTitle(s: ChatSession, fallback: string): string {
  if (s.title) return s.title;
  const firstUser = s.messages.find((m) => m.role === "user");
  if (firstUser) {
    return firstUser.content.slice(0, 32) + (firstUser.content.length > 32 ? "…" : "");
  }
  return fallback;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("read file failed"));
    reader.readAsDataURL(file);
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)}KB`;
  return `${(kb / 1024).toFixed(2)}MB`;
}

export function Chat() {
  const t = useT();
  const chats = useWorkspaceStore((s) => s.chats);
  const agents = useWorkspaceStore((s) => s.agents);
  const createChat = useWorkspaceStore((s) => s.createChat);
  const removeChat = useWorkspaceStore((s) => s.removeChat);
  const renameChat = useWorkspaceStore((s) => s.renameChat);
  const appendMessage = useWorkspaceStore((s) => s.appendMessage);
  const clearChat = useWorkspaceStore((s) => s.clearChat);
  const enqueueTask = useWorkspaceStore((s) => s.enqueueTask);
  const proxyRunning = useAppStore((s) => s.proxyRunning);
  const proxyPort = useAppStore((s) => s.settings.proxyPort);
  const proxyKey = useAppStore((s) => s.settings.proxyKey);
  const proxySource = useAppStore((s) => s.settings.proxySource ?? "local");
  const keys = useAppStore((s) => s.keys);
  const activeKeyId = useAppStore((s) => s.activeKeyId);
  const ensureProxyRunning = useAppStore((s) => s.ensureProxyRunning);
  const serverUrl = useModeStore((s) => s.serverUrl);
  const jwt = useAuthStore((s) => s.session?.tokens.accessToken);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [mode, setMode] = useState<ChatMode>("ask");
  const [agentId, setAgentId] = useState<string | null>(null);
  const [model, setModel] = useState<string>("");
  const [modelOptions, setModelOptions] = useState<SelectOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<ChatAttachment[]>([]);
  const messagesRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const active = useMemo(
    () => chats.find((c) => c.id === activeId) ?? null,
    [chats, activeId],
  );

  // Default-select the most recent chat once on mount or when the active chat
  // disappears (deleted). Never override an explicit user selection.
  useEffect(() => {
    if (activeId && chats.some((c) => c.id === activeId)) return;
    setActiveId(chats[0]?.id ?? null);
  }, [chats, activeId]);

  // Mirror the active chat's mode/agent so the composer reflects its context.
  useEffect(() => {
    if (!active) return;
    setMode(active.mode);
    setAgentId(active.agentId);
  }, [active]);

  // Auto-scroll on new messages.
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [active?.messages.length]);

  const createSession = () => {
    const c = createChat(mode, agentId);
    setActiveId(c.id);
  };

  const activeAgent = useMemo(
    () => agents.find((a) => a.id === agentId) ?? null,
    [agents, agentId],
  );

  /** 本地代理模式：自动确保后台 axum 服务器在跑。
   *  不会改动 Claude Code 的 settings.json，只是保证 127.0.0.1:port 在监听。 */
  useEffect(() => {
    if (proxySource === "local" && !proxyRunning) {
      void ensureProxyRunning();
    }
  }, [proxySource, proxyRunning, ensureProxyRunning]);

  /** 决定 OpenAI 兼容 endpoint 基址：official 走 server，否则走本机代理 */
  const apiBase = useMemo(() => {
    if (proxySource === "official" && serverUrl) {
      return `${serverUrl.replace(/\/+$/, "")}/api/v1`;
    }
    return `http://127.0.0.1:${proxyPort ?? 31415}/v1`;
  }, [proxySource, serverUrl, proxyPort]);

  /** 鉴权头（official → JWT，local → proxyKey）。
   *  内部 Chat 调用打上 `x-ccapi-internal` 标记 —— 让本地代理跳过冷却 / 计费 / 轮换通知，
   *  避免 UI 自身的探测把好 key 一起冷却掉。 */
  const buildAuthHeaders = (): Record<string, string> => {
    const h: Record<string, string> = {
      "content-type": "application/json",
      "x-ccapi-internal": "1",
    };
    if (proxySource === "official" && jwt) {
      h["Authorization"] = `Bearer ${jwt}`;
    } else if (proxySource === "local" && proxyKey) {
      h["Authorization"] = `Bearer ${proxyKey}`;
    }
    return h;
  };

  /** 探测依赖的稳定指纹 —— 只覆盖会影响 `/v1/models` 探测结果的字段。
   *  这样监控扫描更新 status/latency/quota 时不会触发整批 key 的模型重探。 */
  const keysFingerprint = useMemo(() => {
    if (proxySource === "official") return "";
    return keys
      .filter((k) => k.enabled && !!k.key)
      .map((k) =>
        [k.id, k.key, k.url ?? "", k.authField ?? ""].join("|"),
      )
      .join("");
  }, [keys, proxySource]);

  /**
   * 拉「当前代理实际能用的模型列表」——
   * - local 模式：对每把启用的 key 直接探测它上游的 `/v1/models`（绕过本地代理 router，
   *   不会触发冷却 / 计费 / 轮换通知），所有 key 的模型**合并去重**显示成扁平列表
   *   （多把 key 都有的模型只显示一次）
   * - official 模式：走服务端 relay 的 `/api/v1/models`，由后端聚合
   * 所有来源都拉不到时下拉框为空 —— 不再硬编码兜底。
   */
  useEffect(() => {
    let cancelled = false;
    const fetchModels = async () => {
      setModelsLoading(true);
      try {
        const res = await getAvailableModels(
          proxySource === "official"
            ? { source: "official", serverUrl, jwt: jwt ?? null }
            : { source: "local", keys, activeKeyId },
        );
        if (cancelled) return;
        // res.flat 已经按出现顺序（active key 优先）做了去重
        setModelOptions(res.flat.map((m) => ({ value: m, label: m })));
        setModel((cur) => {
          if (res.flat.includes(cur)) return cur;
          return res.flat[0] ?? "";
        });
      } catch {
        if (!cancelled) {
          setModelOptions([]);
          setModel("");
        }
      } finally {
        if (!cancelled) setModelsLoading(false);
      }
    };
    void fetchModels();
    return () => {
      cancelled = true;
    };
    // 依赖用 keysFingerprint 而非 keys，避免 status/latency 等无关字段变化触发重探。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proxySource, serverUrl, jwt, keysFingerprint, activeKeyId]);

  const send = async () => {
    const text = input.trim();
    if (!text && pending.length === 0) return;
    // 本地代理模式：发消息前再确保一次代理在跑（用户可能在自动启动前就按了发送）
    if (proxySource === "local" && !proxyRunning) {
      const ok = await ensureProxyRunning();
      if (!ok) {
        toast.error(t("chat.callFailed"), t("chat.proxyOffHint"));
        return;
      }
    }
    let chat = active;
    if (!chat) {
      chat = createChat(mode, agentId);
      setActiveId(chat.id);
    }
    const userMsg = appendMessage(chat.id, {
      role: "user",
      content: text,
      attachments: pending.length > 0 ? pending : undefined,
    });

    enqueueTask({
      agentId,
      kind: mode === "ask" ? "ask" : "code",
      prompt: text,
    });

    setInput("");
    setPending([]);
    setSending(true);

    // 拼上下文：active 里现在已经有最新 user message
    const history = [
      ...(chat.messages ?? []),
      userMsg,
    ];
    const messages: Array<{ role: string; content: string }> = [];
    const systemPrompt =
      activeAgent?.systemPrompt?.trim() ||
      (mode === "code"
        ? "You are an expert pair-programming assistant. Answer concisely with code where relevant."
        : "You are a helpful assistant.");
    messages.push({ role: "system", content: systemPrompt });
    for (const m of history) {
      if (m.role === "system") continue;
      // 图片附件转 OpenAI vision 格式（兼容 Claude vision）
      const imgAtts = (m.attachments ?? []).filter((a) =>
        a.mime.startsWith("image/"),
      );
      if (imgAtts.length > 0 && m.role === "user") {
        const parts: Array<Record<string, unknown>> = [];
        if (m.content) parts.push({ type: "text", text: m.content });
        for (const img of imgAtts) {
          parts.push({
            type: "image_url",
            image_url: { url: img.dataUrl },
          });
        }
        messages.push({
          role: m.role,
          content: parts as unknown as string, // OpenAI 接受 string 或 parts[]
        });
      } else {
        messages.push({ role: m.role, content: m.content });
      }
    }

    try {
      const resp = await fetch(`${apiBase}/chat/completions`, {
        method: "POST",
        headers: buildAuthHeaders(),
        body: JSON.stringify({
          model,
          messages,
          temperature: mode === "code" ? 0.2 : 0.7,
          max_tokens: 2048,
          stream: false,
        }),
      });
      if (!resp.ok) {
        const errText = (await resp.text()).trim();
        // 上游可能把错误信息分成多行（"hi\nService Unavailable"），CSS 折叠后
        // 会变成 "hiService Unavailable" 这种贴在一起的乱码，统一压成单空格。
        const oneLine = errText.replace(/\s+/g, " ").slice(0, 300);
        const detail = oneLine || resp.statusText || "Request failed";
        throw new Error(`HTTP ${resp.status}: ${detail}`);
      }
      const data = await resp.json();
      const reply =
        data?.choices?.[0]?.message?.content ??
        data?.content?.[0]?.text ??
        "(空响应)";
      appendMessage(chat.id, {
        role: "assistant",
        content: typeof reply === "string" ? reply : JSON.stringify(reply),
      });
    } catch (e: any) {
      const hint = proxyRunning
        ? ""
        : `\n\n${t("chat.proxyOffHint")}`;
      appendMessage(chat.id, {
        role: "assistant",
        content: `⚠️ ${t("chat.callFailed")}: ${e?.message ?? String(e)}${hint}`,
      });
      toast.error(
        t("chat.callFailed"),
        e?.message ?? String(e),
      );
    } finally {
      setSending(false);
    }
  };

  const onPickFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const MAX_PER_FILE = 5 * 1024 * 1024;
    const next: ChatAttachment[] = [];
    for (const f of Array.from(files)) {
      if (f.size > MAX_PER_FILE) {
        toast.warning(t("chat.fileTooLarge", { name: f.name }));
        continue;
      }
      const dataUrl = await readAsDataUrl(f);
      next.push({
        id: uid("att"),
        name: f.name,
        mime: f.type || "application/octet-stream",
        size: f.size,
        dataUrl,
      });
    }
    if (next.length > 0) setPending((cur) => [...cur, ...next]);
  };

  const removePending = (id: string) =>
    setPending((cur) => cur.filter((a) => a.id !== id));

  const onRenameActive = async () => {
    if (!active) return;
    const r = await prompt({
      title: t("chat.rename.title"),
      fields: [
        {
          name: "title",
          label: t("chat.rename.label"),
          defaultValue: active.title || sessionTitle(active, ""),
          required: true,
          autoFocus: true,
        },
      ],
    });
    if (!r) return;
    renameChat(active.id, r.title.trim());
  };

  const onRenameById = async (chat: ChatSession) => {
    const r = await prompt({
      title: t("chat.rename.title"),
      fields: [
        {
          name: "title",
          label: t("chat.rename.label"),
          defaultValue: chat.title || sessionTitle(chat, ""),
          required: true,
          autoFocus: true,
        },
      ],
    });
    if (!r) return;
    renameChat(chat.id, r.title.trim());
  };

  const onDeleteById = async (id: string) => {
    const ok = await confirm({
      title: t("chat.deleteSession"),
      description: t("chat.deleteSessionDesc"),
      level: "danger",
    });
    if (ok) removeChat(id);
  };

  const agentOptions = useMemo(
    () => [
      { id: null as string | null, name: t("chat.agentNone") },
      ...agents.map((a) => ({ id: a.id as string | null, name: a.name })),
    ],
    [agents, t],
  );

  return (
    <div className="grid h-full grid-cols-[260px_minmax(0,1fr)]">
      {/* session list */}
      <aside className="flex h-full min-h-0 flex-col border-r border-border/60 bg-surface/40">
        <div className="flex items-center justify-between gap-2 px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted/70">
            {t("nav.chat")}
          </p>
          <Button size="sm" variant="subtle" onClick={createSession}>
            <MessageSquarePlus className="h-3.5 w-3.5" />
            {t("chat.newSession")}
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {chats.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted/70">
              {t("chat.empty")}
            </p>
          ) : (
            <ul className="space-y-1">
              {chats.map((c) => {
                const isActive = c.id === activeId;
                return (
                  <li key={c.id}>
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => setActiveId(c.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setActiveId(c.id);
                        }
                      }}
                      className={cn(
                        "no-drag group flex w-full cursor-pointer items-center gap-2 rounded-xl px-3 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                        isActive
                          ? "bg-primary/10 text-primary"
                          : "text-text hover:bg-surface-2",
                      )}
                    >
                      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface-2 text-muted">
                        {c.agentId ? (
                          <Bot className="h-3.5 w-3.5" />
                        ) : c.mode === "code" ? (
                          <Wand2 className="h-3.5 w-3.5" />
                        ) : (
                          <Sparkles className="h-3.5 w-3.5" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {sessionTitle(c, t("chat.untitled"))}
                        </span>
                        <span className="mt-0.5 block truncate text-[11px] text-muted/80">
                          {timeAgo(c.updatedAt)} ·{" "}
                          {t("chat.msgCount", { n: String(c.messages.length) })}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void onRenameById(c);
                          }}
                          className="grid h-6 w-6 place-items-center rounded-md text-muted hover:bg-surface/60 hover:text-text"
                          title={t("chat.rename.title")}
                          aria-label={t("chat.rename.title")}
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void onDeleteById(c.id);
                          }}
                          className="grid h-6 w-6 place-items-center rounded-md text-muted hover:bg-danger/10 hover:text-danger"
                          title={t("chat.deleteSession")}
                          aria-label={t("chat.deleteSession")}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* active session */}
      <section className="flex h-full min-h-0 flex-col">
        {!active ? (
          <EmptyState
            icon={MessageSquarePlus}
            title={t("chat.empty")}
            hint={t("chat.emptyHint")}
            action={<Button onClick={createSession}>{t("chat.newSession")}</Button>}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 border-b border-border/60 px-6 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <h2 className="truncate text-sm font-semibold">
                    {sessionTitle(active, t("chat.untitled"))}
                  </h2>
                  <button
                    type="button"
                    onClick={() => void onRenameActive()}
                    className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
                    title={t("chat.rename.title")}
                    aria-label={t("chat.rename.title")}
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                </div>
                <p className="text-[11px] text-muted">
                  {formatDateTime(active.updatedAt)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1 rounded-xl border border-border bg-surface-2/60 p-1">
                  {(["ask", "code"] as ChatMode[]).map((m) => (
                    <button
                      key={m}
                      onClick={() => setMode(m)}
                      className={cn(
                        "no-drag rounded-lg px-3 py-1 text-xs font-medium transition-colors",
                        mode === m
                          ? "bg-primary/15 text-primary"
                          : "text-muted hover:text-text",
                      )}
                      title={
                        m === "ask"
                          ? t("chat.modeAsk.desc")
                          : t("chat.modeCode.desc")
                      }
                    >
                      {m === "ask" ? t("chat.modeAsk") : t("chat.modeCode")}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-1.5" title={t("chat.modelHint")}>
                  <Sparkles
                    className={cn(
                      "h-3.5 w-3.5",
                      modelsLoading ? "animate-pulse text-primary" : "text-muted",
                    )}
                  />
                  <Select
                    value={model}
                    onValueChange={setModel}
                    options={modelOptions}
                    placeholder={modelsLoading ? "..." : "无可用模型"}
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <Bot className="h-3.5 w-3.5 text-muted" />
                  <Select
                    value={agentId ?? ""}
                    onValueChange={(v) => setAgentId(v || null)}
                    options={agentOptions.map((opt) => ({
                      value: opt.id ?? "",
                      label: opt.name,
                    }))}
                  />
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => clearChat(active.id)}
                  disabled={active.messages.length === 0}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("chat.clear")}
                </Button>
              </div>
            </div>

            <div
              ref={messagesRef}
              className="min-h-0 flex-1 overflow-y-auto px-6 py-5"
            >
              {active.messages.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted">
                  {t("chat.emptyHint")}
                </p>
              ) : (
                <ul className="space-y-4">
                  {active.messages.map((m) => {
                    const mine = m.role === "user";
                    return (
                      <li
                        key={m.id}
                        className={cn(
                          "flex",
                          mine ? "justify-end" : "justify-start",
                        )}
                      >
                        <div
                          className={cn(
                            "max-w-[78%] space-y-2 rounded-2xl px-4 py-2.5 text-sm shadow-soft",
                            mine
                              ? "bg-primary text-white dark:text-[#04221d]"
                              : "border border-border bg-surface",
                          )}
                        >
                          <p className="text-[10px] uppercase tracking-wider opacity-70">
                            {t(ROLE_LABEL[m.role])} · {timeAgo(m.createdAt)}
                          </p>
                          {m.content && (
                            <p className="whitespace-pre-wrap leading-relaxed">
                              {m.content}
                            </p>
                          )}
                          {m.attachments && m.attachments.length > 0 && (
                            <div className="flex flex-wrap gap-1.5">
                              {m.attachments.map((a) =>
                                a.mime.startsWith("image/") ? (
                                  <img
                                    key={a.id}
                                    src={a.dataUrl}
                                    alt={a.name}
                                    className="max-h-44 max-w-full rounded-lg border border-border/40"
                                  />
                                ) : (
                                  <span
                                    key={a.id}
                                    className={cn(
                                      "inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px]",
                                      mine
                                        ? "border-white/30 bg-white/10"
                                        : "border-border bg-surface-2",
                                    )}
                                    title={`${a.name} · ${formatBytes(a.size)}`}
                                  >
                                    <FileText className="h-3 w-3" />
                                    <span className="max-w-[14rem] truncate">
                                      {a.name}
                                    </span>
                                  </span>
                                ),
                              )}
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="border-t border-border/60 px-6 pb-5 pt-4">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,application/pdf,text/*,.json,.md,.csv,.log"
                className="hidden"
                onChange={(e) => {
                  void onPickFiles(e.target.files);
                  if (e.target) e.target.value = "";
                }}
              />
              <div
                className={cn(
                  "rounded-2xl border border-border bg-surface-2 p-3 transition-[box-shadow,border-color]",
                  "focus-within:border-primary/60 focus-within:shadow-[0_0_0_3px_rgb(var(--primary)/0.18)]",
                )}
              >
                {pending.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {pending.map((a) => (
                      <span
                        key={a.id}
                        className="group/att inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-2 py-1 text-[11px]"
                      >
                        {a.mime.startsWith("image/") ? (
                          <ImageIcon className="h-3 w-3" />
                        ) : (
                          <FileText className="h-3 w-3" />
                        )}
                        <span className="max-w-[12rem] truncate">{a.name}</span>
                        <span className="text-muted/70">
                          {formatBytes(a.size)}
                        </span>
                        <button
                          type="button"
                          onClick={() => removePending(a.id)}
                          className="ml-0.5 grid h-4 w-4 place-items-center rounded text-muted hover:bg-danger/10 hover:text-danger"
                          aria-label={t("chat.removeAttachment")}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  rows={3}
                  placeholder={
                    mode === "ask"
                      ? t("chat.askPlaceholder")
                      : t("chat.codePlaceholder")
                  }
                  className={cn(
                    "no-drag block min-h-[72px] w-full resize-none bg-transparent text-sm",
                    "placeholder:text-muted/70 outline-none",
                  )}
                />
                <div className="mt-2 flex items-center justify-between gap-3 border-t border-border/40 pt-2">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="grid h-7 w-7 place-items-center rounded-lg text-muted hover:bg-surface/60 hover:text-text"
                      title={t("chat.attach")}
                      aria-label={t("chat.attach")}
                    >
                      <Paperclip className="h-4 w-4" />
                    </button>
                    <p className="text-[11px] text-muted/70">
                      {t("chat.sendHint")}
                    </p>
                  </div>
                  <Button
                    onClick={send}
                    loading={sending}
                    disabled={(!input.trim() && pending.length === 0) || !model}
                    size="sm"
                    className="shrink-0"
                  >
                    <Send className="h-3.5 w-3.5" />
                    <span className="whitespace-nowrap">
                      {sending ? t("chat.sending") : t("chat.send")}
                    </span>
                  </Button>
                </div>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

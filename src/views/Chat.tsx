import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  MessageSquarePlus,
  Send,
  Sparkles,
  Trash2,
  Wand2,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/workspace/EmptyState";
import { useT } from "@/i18n";
import type { ChatMode, ChatSession } from "@/types";
import type { MessageKey } from "@/i18n/messages";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import { useAppStore } from "@/store/useAppStore";
import { toast } from "@/store/useToastStore";
import { cn } from "@/lib/cn";
import { formatDateTime, timeAgo } from "@/lib/format";

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

export function Chat() {
  const t = useT();
  const chats = useWorkspaceStore((s) => s.chats);
  const agents = useWorkspaceStore((s) => s.agents);
  const createChat = useWorkspaceStore((s) => s.createChat);
  const removeChat = useWorkspaceStore((s) => s.removeChat);
  const appendMessage = useWorkspaceStore((s) => s.appendMessage);
  const clearChat = useWorkspaceStore((s) => s.clearChat);
  const enqueueTask = useWorkspaceStore((s) => s.enqueueTask);
  const proxyRunning = useAppStore((s) => s.proxyRunning);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [mode, setMode] = useState<ChatMode>("ask");
  const [agentId, setAgentId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);

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

  const send = () => {
    const text = input.trim();
    if (!text) return;
    let chat = active;
    if (!chat) {
      chat = createChat(mode, agentId);
      setActiveId(chat.id);
    }
    setSending(true);
    appendMessage(chat.id, { role: "user", content: text });

    // Mirror the prompt into the task queue so it appears under "Tasks".
    enqueueTask({
      agentId,
      kind: mode === "ask" ? "ask" : "code",
      prompt: text,
    });

    // The proxy can forward real Claude traffic when running; here we record an
    // assistant reply that explains the local execution model. If/when a live
    // streaming backend lands, this is the single place that needs replacing.
    const replyBody = proxyRunning
      ? t("chat.echo")
      : `${t("chat.proxyOff")}\n\n${t("chat.echo")}`;
    appendMessage(chat.id, { role: "assistant", content: replyBody });

    setInput("");
    setSending(false);
    toast.info(t("chat.sentLocal"));
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
                    <button
                      onClick={() => setActiveId(c.id)}
                      className={cn(
                        "no-drag group flex w-full items-start gap-2 rounded-xl px-3 py-2 text-left transition-colors",
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
                        <span className="block truncate text-[11px] text-muted/80">
                          {timeAgo(c.updatedAt)} · {c.messages.length}
                        </span>
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm(t("chat.deleteSession"))) {
                            removeChat(c.id);
                          }
                        }}
                        className="opacity-0 transition-opacity group-hover:opacity-100"
                        title={t("chat.deleteSession")}
                        aria-label={t("chat.deleteSession")}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-muted hover:text-danger" />
                      </button>
                    </button>
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
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold">
                  {sessionTitle(active, t("chat.untitled"))}
                </h2>
                <p className="text-[11px] text-muted">
                  {formatDateTime(active.updatedAt)}
                </p>
              </div>
              <div className="ml-auto flex flex-wrap items-center gap-2">
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
                <label className="flex items-center gap-2 rounded-xl border border-border bg-surface-2/60 px-3 py-1.5 text-xs text-muted">
                  <Bot className="h-3.5 w-3.5" />
                  <select
                    value={agentId ?? ""}
                    onChange={(e) => setAgentId(e.target.value || null)}
                    className="no-drag bg-transparent text-xs text-text outline-none"
                  >
                    {agentOptions.map((opt) => (
                      <option key={opt.id ?? "none"} value={opt.id ?? ""}>
                        {opt.name}
                      </option>
                    ))}
                  </select>
                </label>
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
                            "max-w-[78%] rounded-2xl px-4 py-2.5 text-sm shadow-soft",
                            mine
                              ? "bg-primary text-white dark:text-[#04221d]"
                              : "border border-border bg-surface",
                          )}
                        >
                          <p className="mb-1 text-[10px] uppercase tracking-wider opacity-70">
                            {t(ROLE_LABEL[m.role])} · {timeAgo(m.createdAt)}
                          </p>
                          <p className="whitespace-pre-wrap leading-relaxed">
                            {m.content}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="border-t border-border/60 px-6 py-4">
              <div className="flex items-end gap-2">
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
                    "no-drag w-full resize-none rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 text-sm",
                    "placeholder:text-muted/70 outline-none transition-[box-shadow,border-color] duration-200",
                    "focus:border-primary/60 focus:shadow-[0_0_0_3px_rgb(var(--primary)/0.18)]",
                  )}
                />
                <Button onClick={send} loading={sending} disabled={!input.trim()}>
                  <Send className="h-4 w-4" />
                  {sending ? t("chat.sending") : t("chat.send")}
                </Button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

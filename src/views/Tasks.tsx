import { useMemo, useState } from "react";
import { ClipboardList, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { WorkspacePage } from "@/components/workspace/WorkspacePage";
import { EmptyState } from "@/components/workspace/EmptyState";
import { useT } from "@/i18n";
import type { AgentTask, AgentTaskKind, AgentTaskStatus } from "@/types";
import type { MessageKey } from "@/i18n/messages";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import { useAppStore } from "@/store/useAppStore";
import { cn } from "@/lib/cn";
import { formatDateTime, timeAgo } from "@/lib/format";

const KIND_LABEL: Record<AgentTaskKind, MessageKey> = {
  ask: "task.kind.ask",
  code: "task.kind.code",
  review: "task.kind.review",
  test: "task.kind.test",
  refactor: "task.kind.refactor",
};

const STATUS_LABEL: Record<AgentTaskStatus, MessageKey> = {
  queued: "task.status.queued",
  running: "task.status.running",
  succeeded: "task.status.succeeded",
  failed: "task.status.failed",
  canceled: "task.status.canceled",
};

const STATUS_STYLE: Record<AgentTaskStatus, string> = {
  queued: "bg-surface-2 text-muted",
  running: "bg-primary/15 text-primary",
  succeeded: "bg-success/15 text-success",
  failed: "bg-danger/15 text-danger",
  canceled: "bg-surface-2 text-muted",
};

const FILTERS: { value: "all" | AgentTaskStatus; labelKey: MessageKey }[] = [
  { value: "all", labelKey: "dash.filterAll" },
  { value: "queued", labelKey: "task.status.queued" },
  { value: "running", labelKey: "task.status.running" },
  { value: "succeeded", labelKey: "task.status.succeeded" },
  { value: "failed", labelKey: "task.status.failed" },
];

export function Tasks() {
  const t = useT();
  const tasks = useWorkspaceStore((s) => s.tasks);
  const agents = useWorkspaceStore((s) => s.agents);
  const updateStatus = useWorkspaceStore((s) => s.updateTaskStatus);
  const clearFinished = useWorkspaceStore((s) => s.clearFinishedTasks);
  const removeTask = useWorkspaceStore((s) => s.removeTask);
  const createChat = useWorkspaceStore((s) => s.createChat);
  const appendMessage = useWorkspaceStore((s) => s.appendMessage);
  const setView = useAppStore((s) => s.setView);

  const [filter, setFilter] = useState<"all" | AgentTaskStatus>("all");

  const agentName = (id: string | null) =>
    agents.find((a) => a.id === id)?.name ?? t("task.noAgent");

  const filtered = useMemo(() => {
    if (filter === "all") return tasks;
    return tasks.filter((tk) => tk.status === filter);
  }, [tasks, filter]);

  const counts = useMemo(() => {
    const acc: Record<string, number> = { all: tasks.length };
    for (const tk of tasks) {
      acc[tk.status] = (acc[tk.status] ?? 0) + 1;
    }
    return acc;
  }, [tasks]);

  const openInChat = (task: AgentTask) => {
    const chat = createChat(
      task.kind === "ask" ? "ask" : "code",
      task.agentId,
      `${t("chat.sessionPrefix")} · ${agentName(task.agentId)}`,
    );
    appendMessage(chat.id, { role: "user", content: task.prompt });
    if (task.summary) {
      appendMessage(chat.id, { role: "assistant", content: task.summary });
    }
    setView("chat");
  };

  const renderActions = (task: AgentTask) => {
    if (task.status === "queued") {
      return (
        <>
          <Button
            size="sm"
            variant="subtle"
            onClick={() => updateStatus(task.id, "running")}
          >
            {t("task.markRunning")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => updateStatus(task.id, "canceled")}
          >
            {t("task.markCanceled")}
          </Button>
        </>
      );
    }
    if (task.status === "running") {
      return (
        <>
          <Button
            size="sm"
            variant="subtle"
            onClick={() => updateStatus(task.id, "succeeded", t("chat.echo"))}
          >
            {t("task.markSucceeded")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => updateStatus(task.id, "failed")}
          >
            {t("task.markFailed")}
          </Button>
        </>
      );
    }
    return null;
  };

  return (
    <WorkspacePage
      toolbarExtra={
        <>
          <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-border bg-surface-2/60 p-1">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setFilter(f.value)}
                className={cn(
                  "no-drag rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                  filter === f.value
                    ? "bg-primary/15 text-primary"
                    : "text-muted hover:text-text",
                )}
              >
                {t(f.labelKey)} {counts[f.value] ? `· ${counts[f.value]}` : ""}
              </button>
            ))}
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={clearFinished}
            disabled={tasks.every(
              (tk) => tk.status === "queued" || tk.status === "running",
            )}
          >
            {t("task.clearFinished")}
          </Button>
        </>
      }
    >
      {filtered.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title={tasks.length === 0 ? t("task.empty") : t("dash.noMatch")}
          hint={tasks.length === 0 ? t("task.emptyHint") : undefined}
        />
      ) : (
        <ul className="space-y-3">
          {filtered.map((task) => (
            <li
              key={task.id}
              className="rounded-2xl border border-border bg-surface/50 p-4 shadow-soft backdrop-blur-md"
            >
              <header className="flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[11px] font-medium",
                    STATUS_STYLE[task.status],
                  )}
                >
                  {t(STATUS_LABEL[task.status])}
                </span>
                <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted">
                  {t(KIND_LABEL[task.kind])}
                </span>
                <span className="text-sm font-medium">{agentName(task.agentId)}</span>
                <span className="ml-auto text-[11px] text-muted/80">
                  {t("task.createdAt", { time: timeAgo(task.createdAt) })}
                </span>
              </header>
              <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm text-text/90">
                {task.prompt}
              </p>
              {task.summary && (
                <p className="mt-2 rounded-lg bg-surface-2/60 px-3 py-2 text-xs text-muted">
                  {task.summary}
                </p>
              )}
              <footer className="mt-3 flex flex-wrap items-center gap-2">
                {task.finishedAt && (
                  <span className="text-[11px] text-muted/80">
                    {t("task.finishedAt", { time: formatDateTime(task.finishedAt) })}
                  </span>
                )}
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  {renderActions(task)}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => openInChat(task)}
                  >
                    <MessageSquare className="h-3.5 w-3.5" />
                    {t("task.openInChat")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => removeTask(task.id)}
                  >
                    {t("ws.delete")}
                  </Button>
                </div>
              </footer>
            </li>
          ))}
        </ul>
      )}
    </WorkspacePage>
  );
}

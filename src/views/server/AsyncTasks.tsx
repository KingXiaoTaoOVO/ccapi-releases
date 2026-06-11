import { useCallback, useEffect, useState } from "react";
import { ListChecks, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { apiGet } from "@/services/apiClient";
import { notify } from "@/services/notify";

interface Task {
  id: number;
  userId: number;
  taskType: string;
  status: string;
  progress: number;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string | null;
}

const STATUS_CLASS: Record<string, string> = {
  queued: "bg-muted/15 text-muted",
  running: "bg-primary/15 text-primary",
  succeeded: "bg-success/15 text-success",
  failed: "bg-danger/15 text-danger",
  cancelled: "bg-warning/15 text-warning",
};

export function AsyncTasks() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 12 });
  const [list, setList] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiGet<{ tasks: Task[] }>("/api/admin/tasks");
      setList(r.tasks);
    } catch (e: any) {
      notify("error", t("common.loadFail"), e?.message);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
    const id = window.setInterval(load, 15_000);
    return () => window.clearInterval(id);
  }, [load]);

  return (
    <div ref={ref} className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex items-end justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <ListChecks className="h-5 w-5 text-primary" />
              {t("tasks.title")}
            </h1>
            <p className="mt-1 text-sm text-muted">{t("tasks.subtitle")}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
            {t("common.refresh")}
          </Button>
        </header>

        {list.length === 0 ? (
          <div className="grid place-items-center rounded-2xl border border-dashed border-border bg-surface/40 py-16 text-sm text-muted">
            {t("tasks.empty")}
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-border bg-surface/60 backdrop-blur-xl">
            <table className="w-full text-sm">
              <thead className="bg-surface-2/60 text-xs text-muted">
                <tr>
                  <th className="px-3 py-2.5 text-left">#</th>
                  <th className="px-3 py-2.5 text-left">{t("tasks.col.user")}</th>
                  <th className="px-3 py-2.5 text-left">{t("tasks.col.type")}</th>
                  <th className="px-3 py-2.5 text-left">{t("tasks.col.status")}</th>
                  <th className="px-3 py-2.5 text-left">{t("tasks.col.progress")}</th>
                  <th className="px-3 py-2.5 text-left">{t("tasks.col.createdAt")}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((task) => (
                  <tr key={task.id} className="border-t border-border/60">
                    <td className="px-3 py-2.5 font-mono text-xs">{task.id}</td>
                    <td className="px-3 py-2.5">#{task.userId}</td>
                    <td className="px-3 py-2.5">{task.taskType}</td>
                    <td className="px-3 py-2.5">
                      <span
                        className={
                          "rounded-full px-2 py-0.5 text-[10px] " +
                          (STATUS_CLASS[task.status] ?? "bg-muted/15 text-muted")
                        }
                      >
                        {task.status}
                      </span>
                      {task.error && (
                        <div className="mt-0.5 truncate text-[10px] text-danger" title={task.error}>
                          {task.error}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-2">
                        <div
                          className="h-full bg-primary transition-all"
                          style={{ width: `${Math.max(0, Math.min(100, task.progress))}%` }}
                        />
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted">
                      {task.createdAt ? new Date(task.createdAt).toLocaleString() : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

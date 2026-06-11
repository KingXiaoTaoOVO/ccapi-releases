import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { apiGet } from "@/services/apiClient";
import { notify } from "@/services/notify";
import { cn } from "@/lib/cn";

interface Row {
  id: number;
  actorId: number;
  actorName: string | null;
  action: string;
  targetType: string | null;
  targetId: number | null;
  targetName: string | null;
  payload: unknown;
  createdAt: string | null;
}

const ACTION_COLORS: Record<string, string> = {
  "user.ban": "bg-danger/15 text-danger",
  "user.unban": "bg-success/15 text-success",
  "user.freeze": "bg-warning/15 text-warning",
  "user.unfreeze": "bg-success/15 text-success",
  "user.kick": "bg-warning/15 text-warning",
  "user.reset_password": "bg-warning/15 text-warning",
  "user.delete": "bg-danger/15 text-danger",
  "token.revoke": "bg-danger/15 text-danger",
  "usage.purge": "bg-danger/15 text-danger",
  "logs.purge": "bg-danger/15 text-danger",
  "invitations.purge": "bg-danger/15 text-danger",
  "audit.purge": "bg-danger/15 text-danger",
};

export function AuditLog() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 12 });
  const [list, setList] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [actorFilter, setActorFilter] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ limit: "500" });
      if (actorFilter.trim()) qs.set("actorId", actorFilter.trim());
      if (actionFilter.trim()) qs.set("action", actionFilter.trim());
      const r = await apiGet<{ logs: Row[] }>(`/api/admin/audit-logs?${qs}`);
      setList(r.logs);
    } catch (e: any) {
      notify("error", t("common.loadFail"), e?.message);
    } finally {
      setLoading(false);
    }
  }, [actorFilter, actionFilter, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (id: number) =>
    setExpanded((s) => {
      const ns = new Set(s);
      if (ns.has(id)) ns.delete(id);
      else ns.add(id);
      return ns;
    });

  const actions = useMemo(() => {
    const set = new Set(list.map((r) => r.action));
    return Array.from(set).sort();
  }, [list]);

  return (
    <div ref={ref} className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">{t("audit.title")}</h1>
            <p className="mt-1 text-sm text-muted">{t("audit.subtitle")}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
            {t("common.refresh")}
          </Button>
        </header>

        <div className="flex flex-wrap items-center gap-2">
          <TextField
            value={actorFilter}
            onChange={(e) => setActorFilter(e.target.value)}
            placeholder={t("audit.filterActor")}
            className="w-40"
          />
          <TextField
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            placeholder={t("audit.filterAction")}
            className="w-48"
            list="audit-actions"
          />
          <datalist id="audit-actions">
            {actions.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        </div>

        {list.length === 0 && !loading ? (
          <div className="grid place-items-center rounded-2xl border border-dashed border-border bg-surface/40 py-16 text-sm text-muted">
            {t("audit.empty")}
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-border bg-surface/60 backdrop-blur-xl">
            <table className="w-full text-sm">
              <thead className="bg-surface-2/60 text-xs text-muted">
                <tr>
                  <th className="w-8 px-2 py-2.5"></th>
                  <th className="px-3 py-2.5 text-left">{t("audit.col.when")}</th>
                  <th className="px-3 py-2.5 text-left">{t("audit.col.actor")}</th>
                  <th className="px-3 py-2.5 text-left">{t("audit.col.action")}</th>
                  <th className="px-3 py-2.5 text-left">{t("audit.col.target")}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => {
                  const isOpen = expanded.has(r.id);
                  const hasPayload = r.payload !== null && r.payload !== undefined;
                  return (
                    <>
                      <tr
                        key={r.id}
                        className={cn(
                          "border-t border-border/60",
                          hasPayload && "cursor-pointer hover:bg-surface-2/30",
                        )}
                        onClick={() => hasPayload && toggle(r.id)}
                      >
                        <td className="px-2 py-2 text-muted">
                          {hasPayload ? (
                            isOpen ? (
                              <ChevronDown className="h-3.5 w-3.5" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5" />
                            )
                          ) : null}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {r.createdAt
                            ? new Date(r.createdAt + "Z").toLocaleString()
                            : "—"}
                        </td>
                        <td className="px-3 py-2">
                          <div className="text-xs">{r.actorName ?? "?"}</div>
                          <div className="font-mono text-[10px] text-muted">
                            #{r.actorId}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={cn(
                              "rounded-full px-2 py-0.5 font-mono text-[11px]",
                              ACTION_COLORS[r.action] ?? "bg-surface-2 text-muted",
                            )}
                          >
                            {r.action}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {r.targetType ? (
                            <>
                              <span className="text-muted">{r.targetType}</span>
                              {r.targetName && (
                                <span className="ml-1 font-medium">
                                  {r.targetName}
                                </span>
                              )}
                              {r.targetId != null && (
                                <span className="ml-1 font-mono text-[10px] text-muted/80">
                                  #{r.targetId}
                                </span>
                              )}
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                      {isOpen && hasPayload && (
                        <tr className="border-t border-border/30 bg-surface-2/20">
                          <td colSpan={5} className="px-3 py-2">
                            <pre className="overflow-x-auto rounded-lg bg-surface/60 p-3 font-mono text-[11px] leading-relaxed">
                              {JSON.stringify(r.payload, null, 2)}
                            </pre>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex items-start gap-2 rounded-xl border border-border/60 bg-surface-2/40 px-3 py-2.5 text-xs text-muted">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
          <p>{t("audit.tip")}</p>
        </div>
      </div>
    </div>
  );
}

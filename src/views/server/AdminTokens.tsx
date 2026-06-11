import { useCallback, useEffect, useState } from "react";
import { KeyRound, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { TextField } from "@/components/ui/TextField";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { apiDelete, apiGet } from "@/services/apiClient";
import { notify } from "@/services/notify";
import { confirm } from "@/store/useConfirmStore";

interface Row {
  id: number;
  userId: number;
  username: string;
  name: string;
  keyPreview: string;
  quotaUsd: string | null;
  usedUsd: string;
  expiresAt: string | null;
  revoked: number;
  lastUsedAt: string | null;
  createdAt: string | null;
}

type StateFilter = "all" | "active" | "revoked";

export function AdminTokens() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 12 });
  const [list, setList] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [state, setState] = useState<StateFilter>("active");
  const [userFilter, setUserFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ state, limit: "500" });
      if (userFilter.trim()) qs.set("userId", userFilter.trim());
      const r = await apiGet<{ tokens: Row[] }>(`/api/admin/tokens?${qs}`);
      setList(r.tokens);
    } catch (e: any) {
      notify("error", t("common.loadFail"), e?.message);
    } finally {
      setLoading(false);
    }
  }, [state, userFilter, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const onRevoke = async (row: Row) => {
    const ok = await confirm({
      title: t("adminTokens.revokeTitle", { name: row.name }),
      description: t("adminTokens.revokeDesc", { user: row.username }),
      level: "critical",
      confirmText: row.name,
    });
    if (!ok) return;
    try {
      await apiDelete(`/api/admin/tokens/${row.id}`);
      notify("success", t("adminTokens.revokeDone"));
      await load();
    } catch (e: any) {
      notify("error", t("adminTokens.revokeFail"), e?.message);
    }
  };

  return (
    <div ref={ref} className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">{t("adminTokens.title")}</h1>
            <p className="mt-1 text-sm text-muted">{t("adminTokens.subtitle")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <TextField
              value={userFilter}
              onChange={(e) => setUserFilter(e.target.value)}
              placeholder={t("adminTokens.filterUser")}
              className="w-44"
            />
            <Select
              value={state}
              onValueChange={(v) => setState(v as StateFilter)}
              options={[
                { value: "active", label: t("adminTokens.state.active") },
                { value: "revoked", label: t("adminTokens.state.revoked") },
                { value: "all", label: t("adminTokens.state.all") },
              ]}
            />
            <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
              {t("common.refresh")}
            </Button>
          </div>
        </header>

        {list.length === 0 && !loading ? (
          <div className="grid place-items-center rounded-2xl border border-dashed border-border bg-surface/40 py-16 text-sm text-muted">
            {t("adminTokens.empty")}
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-border bg-surface/60 backdrop-blur-xl">
            <table className="w-full text-sm">
              <thead className="bg-surface-2/60 text-xs text-muted">
                <tr>
                  <th className="px-3 py-2.5 text-left">{t("adminTokens.col.user")}</th>
                  <th className="px-3 py-2.5 text-left">{t("adminTokens.col.name")}</th>
                  <th className="px-3 py-2.5 text-left">{t("adminTokens.col.key")}</th>
                  <th className="px-3 py-2.5 text-right">{t("adminTokens.col.usage")}</th>
                  <th className="px-3 py-2.5 text-left">{t("adminTokens.col.state")}</th>
                  <th className="px-3 py-2.5 text-left">{t("adminTokens.col.lastUsed")}</th>
                  <th className="px-3 py-2.5 text-right">{t("adminTokens.col.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => {
                  const limit = r.quotaUsd ? Number(r.quotaUsd) : null;
                  const used = Number(r.usedUsd);
                  return (
                    <tr key={r.id} className="border-t border-border/60 hover:bg-surface-2/30">
                      <td className="px-3 py-2.5">
                        <div className="font-medium">{r.username}</div>
                        <div className="text-[10px] text-muted">#{r.userId}</div>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="font-medium">{r.name}</div>
                      </td>
                      <td className="px-3 py-2.5">
                        <code className="font-mono text-[11px] text-muted">
                          {r.keyPreview}
                        </code>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        ${used.toFixed(4)}
                        {limit != null && limit > 0 ? (
                          <span className="text-muted"> / ${limit.toFixed(2)}</span>
                        ) : (
                          <span className="text-muted"> / ∞</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        {r.revoked ? (
                          <span className="rounded-full bg-danger/15 px-2 py-0.5 text-[10px] text-danger">
                            {t("tokens.revoked")}
                          </span>
                        ) : r.expiresAt && new Date(r.expiresAt + "Z") < new Date() ? (
                          <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] text-warning">
                            {t("tokens.expired")}
                          </span>
                        ) : (
                          <span className="rounded-full bg-success/15 px-2 py-0.5 text-[10px] text-success">
                            {t("adminTokens.state.active")}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-xs">
                        {r.lastUsedAt
                          ? new Date(r.lastUsedAt + "Z").toLocaleString()
                          : "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void onRevoke(r)}
                          disabled={!!r.revoked}
                          className="text-danger hover:bg-danger/10"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          {t("adminTokens.revoke")}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-surface-2/40 px-3 py-2.5 text-xs text-muted">
          <KeyRound className="h-3.5 w-3.5" />
          {t("adminTokens.tip")}
        </div>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { Crown, Mail, RefreshCw, Users } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { apiGet } from "@/services/apiClient";
import { notify } from "@/services/notify";

interface InviteRow {
  id: number;
  inviterId: number;
  inviterName: string;
  inviteeId: number;
  inviteeName: string;
  rewardInviterUsd: string | null;
  rewardInviteeUsd: string | null;
  createdAt: string | null;
}

interface Leader {
  inviterId: number;
  inviterName: string;
  invitedCount: number;
  totalRewardUsd: string | null;
}

interface Stats {
  totalInvites: number;
  totalRewardUsd: string;
  leaderboard: Leader[];
}

export function Invitations() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 12 });
  const [inviterId, setInviterId] = useState("");
  const [rows, setRows] = useState<InviteRow[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = inviterId ? `?inviterId=${inviterId}` : "";
      const [a, b] = await Promise.all([
        apiGet<{ invitations: InviteRow[] }>(`/api/admin/invitations${q}`),
        apiGet<Stats>("/api/admin/invitations/stats"),
      ]);
      setRows(a.invitations);
      setStats(b);
    } catch (e: any) {
      notify("error", "加载失败", e?.message);
    } finally {
      setLoading(false);
    }
  }, [inviterId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div ref={ref} className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border/60 px-6 py-4">
        <Mail className="h-4 w-4 text-primary" />
        <h1 className="text-sm font-semibold">{t("admin.invites.title")}</h1>
        <TextField
          placeholder={t("admin.invites.filter")}
          value={inviterId}
          onChange={(e) => setInviterId(e.target.value.replace(/[^0-9]/g, ""))}
          className="max-w-[200px]"
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void load()}
          loading={loading}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {t("admin.invites.refresh")}
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Stat
            icon={Users}
            label={t("admin.invites.totalInvites")}
            value={String(stats?.totalInvites ?? 0)}
          />
          <Stat
            icon={Crown}
            label={t("admin.invites.totalReward")}
            value={`$${Number(stats?.totalRewardUsd ?? 0).toFixed(2)}`}
            accent="text-success"
          />
          <Stat
            icon={Mail}
            label={t("admin.invites.uniqueInviters")}
            value={String(stats?.leaderboard.length ?? 0)}
          />
        </div>

        <section className="rounded-2xl border border-border bg-surface/40">
          <header className="border-b border-border px-4 py-2.5 text-xs font-semibold text-muted">
            {t("admin.invites.leaderboard")}
          </header>
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-xs text-muted">
              <tr>
                <th className="px-3 py-2 text-left">{t("admin.invites.col.rank")}</th>
                <th className="px-3 py-2 text-left">{t("admin.invites.col.inviter")}</th>
                <th className="px-3 py-2 text-right">{t("admin.invites.col.count")}</th>
                <th className="px-3 py-2 text-right">{t("admin.invites.col.reward")}</th>
              </tr>
            </thead>
            <tbody>
              {stats?.leaderboard.map((l, i) => (
                <tr key={l.inviterId} className="border-t border-border/40">
                  <td className="px-3 py-2 text-xs text-muted">#{i + 1}</td>
                  <td className="px-3 py-2 text-xs">
                    <span className="font-medium">{l.inviterName}</span>
                    <span className="ml-1 text-muted">#{l.inviterId}</span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {l.invitedCount}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    ${Number(l.totalRewardUsd ?? 0).toFixed(2)}
                  </td>
                </tr>
              ))}
              {(!stats || stats.leaderboard.length === 0) && (
                <tr>
                  <td colSpan={4} className="p-6 text-center text-xs text-muted">
                    {t("admin.invites.emptyLeaderboard")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        <section className="rounded-2xl border border-border bg-surface/40">
          <header className="border-b border-border px-4 py-2.5 text-xs font-semibold text-muted">
            {t("admin.invites.recent")}
          </header>
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-xs text-muted">
              <tr>
                <th className="px-3 py-2 text-left">{t("admin.invites.col.when")}</th>
                <th className="px-3 py-2 text-left">{t("admin.invites.col.inviter")}</th>
                <th className="px-3 py-2 text-left">{t("admin.invites.col.invitee")}</th>
                <th className="px-3 py-2 text-right">{t("admin.invites.col.bonus")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border/40">
                  <td className="px-3 py-2 text-xs text-muted">
                    {r.createdAt
                      ? new Date(r.createdAt + "Z").toLocaleString()
                      : "—"}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.inviterName}{" "}
                    <span className="text-muted">#{r.inviterId}</span>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.inviteeName}{" "}
                    <span className="text-muted">#{r.inviteeId}</span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    ${Number(r.rewardInviterUsd ?? 0).toFixed(2)} /
                    ${Number(r.rewardInviteeUsd ?? 0).toFixed(2)}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && !loading && (
                <tr>
                  <td colSpan={4} className="p-6 text-center text-xs text-muted">
                    {t("admin.invites.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: typeof Users;
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface/60 p-4">
      <div className="flex items-center gap-2 text-xs text-muted">
        <Icon className={`h-4 w-4 ${accent ?? "text-primary"}`} />
        {label}
      </div>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

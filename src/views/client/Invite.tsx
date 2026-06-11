import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Link2, Mail, Users } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { apiGet } from "@/services/apiClient";
import { notify } from "@/services/notify";
import { useModeStore } from "@/store/useModeStore";

interface Inv {
  id: number;
  inviterId: number;
  inviteeId: number;
  rewardInviterUsd: string | null;
  rewardInviteeUsd: string | null;
  createdAt: string | null;
}

export function Invite() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 12 });
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [list, setList] = useState<Inv[]>([]);
  const [total, setTotal] = useState(0);
  const [copied, setCopied] = useState(false);
  const serverUrl = useModeStore((s) => s.serverUrl);

  const load = useCallback(async () => {
    try {
      const d = await apiGet<{
        inviteCode: string;
        invitations: Inv[];
        totalRewardUsd: number;
      }>("/api/user/me/invitations");
      setInviteCode(d.inviteCode);
      setList(d.invitations);
      setTotal(d.totalRewardUsd);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const url = serverUrl && inviteCode ? `${serverUrl}/r?code=${inviteCode}` : "";

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    notify("success", t("client.invite.copied"));
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div ref={ref} className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-xl font-semibold">{t("client.invite.title")}</h1>
          <p className="text-sm text-muted">{t("client.invite.subtitle")}</p>
        </header>

        <section className="rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
          <div className="flex items-center gap-2 text-xs text-muted">
            <Link2 className="h-4 w-4 text-primary" />
            {t("client.invite.code")}
          </div>
          <p className="mt-2 font-mono text-lg font-semibold tabular-nums">
            {inviteCode ?? "—"}
          </p>
          {inviteCode && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => copy(inviteCode)}
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                {t("client.invite.copyCode")}
              </Button>
              {url && (
                <Button size="sm" variant="secondary" onClick={() => copy(url)}>
                  <Copy className="h-3.5 w-3.5" />
                  {t("client.invite.copyLink")}
                </Button>
              )}
            </div>
          )}
        </section>

        <section className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Stat
            icon={Users}
            label={t("client.invite.totalCount")}
            value={String(list.length)}
          />
          <Stat
            icon={Mail}
            label={t("client.invite.totalReward")}
            value={`$${total.toFixed(2)}`}
            accent="text-success"
          />
        </section>

        <section className="rounded-2xl border border-border bg-surface/40">
          <header className="border-b border-border px-4 py-2.5 text-xs font-semibold text-muted">
            {t("client.invite.list")}
          </header>
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-xs text-muted">
              <tr>
                <th className="px-3 py-2 text-left">User ID</th>
                <th className="px-3 py-2 text-right">{t("client.invite.reward")}</th>
                <th className="px-3 py-2 text-right">{t("client.invite.when")}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((i) => (
                <tr key={i.id} className="border-t border-border/40">
                  <td className="px-3 py-2 text-xs">#{i.inviteeId}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    ${Number(i.rewardInviterUsd ?? 0).toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-right text-xs text-muted">
                    {i.createdAt
                      ? new Date(i.createdAt + "Z").toLocaleString()
                      : "—"}
                  </td>
                </tr>
              ))}
              {list.length === 0 && (
                <tr>
                  <td colSpan={3} className="p-6 text-center text-xs text-muted">
                    {t("client.invite.empty")}
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

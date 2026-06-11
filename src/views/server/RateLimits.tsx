import { useCallback, useEffect, useState } from "react";
import { Gauge, Save } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { apiGet, apiPatch } from "@/services/apiClient";
import { notify } from "@/services/notify";

interface Limits {
  api_rate_per_minute: number | null;
  login_rate_per_minute: number | null;
  rate_limit_per_user_per_minute: number | null;
  rate_limit_per_group_per_minute: Record<string, number> | null;
}

interface UserGroup {
  id: number;
  code: string;
  displayName: string;
}

export function RateLimits() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 12 });
  const [g, setG] = useState("60");
  const [l, setL] = useState("5");
  const [u, setU] = useState("120");
  const [perGroup, setPerGroup] = useState<Record<string, string>>({});
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [r, gs] = await Promise.all([
        apiGet<{ limits: Limits }>("/api/admin/rate-limits"),
        apiGet<{ groups: UserGroup[] }>("/api/admin/user-groups").catch(
          () => ({ groups: [] as UserGroup[] }),
        ),
      ]);
      setG(String(r.limits.api_rate_per_minute ?? 60));
      setL(String(r.limits.login_rate_per_minute ?? 5));
      setU(String(r.limits.rate_limit_per_user_per_minute ?? 120));
      const pg: Record<string, string> = {};
      const src = r.limits.rate_limit_per_group_per_minute ?? {};
      for (const k in src) pg[k] = String(src[k]);
      setPerGroup(pg);
      setGroups(gs.groups);
    } catch (e: any) {
      notify("error", t("common.loadFail"), e?.message);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const groupMap: Record<string, number> = {};
      for (const [k, v] of Object.entries(perGroup)) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) groupMap[k] = n;
      }
      await apiPatch("/api/admin/rate-limits", {
        apiRatePerMinute: Number(g) || 0,
        loginRatePerMinute: Number(l) || 0,
        rateLimitPerUserPerMinute: Number(u) || 0,
        rateLimitPerGroupPerMinute: groupMap,
      });
      notify("success", t("common.saved"));
    } catch (e: any) {
      notify("error", t("common.saveFail"), e?.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div ref={ref} className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-2xl space-y-6">
        <header className="flex items-end justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <Gauge className="h-5 w-5 text-primary" />
              {t("rl.title")}
            </h1>
            <p className="mt-1 text-sm text-muted">{t("rl.subtitle")}</p>
          </div>
          <Button onClick={() => void save()} loading={saving}>
            <Save className="h-3.5 w-3.5" />
            {t("common.save")}
          </Button>
        </header>

        <section className="space-y-3 rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
          <TextField
            label={t("rl.global")}
            value={g}
            onChange={(e) => setG(e.target.value)}
            type="number"
            hint={t("rl.global.hint")}
          />
          <TextField
            label={t("rl.login")}
            value={l}
            onChange={(e) => setL(e.target.value)}
            type="number"
            hint={t("rl.login.hint")}
          />
          <TextField
            label={t("rl.perUser")}
            value={u}
            onChange={(e) => setU(e.target.value)}
            type="number"
            hint={t("rl.perUser.hint")}
          />
        </section>

        {groups.length > 0 && (
          <section className="space-y-3 rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
            <h2 className="text-sm font-semibold">{t("rl.perGroup")}</h2>
            <p className="text-xs text-muted">{t("rl.perGroup.hint")}</p>
            <div className="space-y-2">
              {groups.map((gg) => (
                <div key={gg.id} className="flex items-center gap-3">
                  <span className="w-32 truncate text-sm">{gg.displayName}</span>
                  <TextField
                    value={perGroup[String(gg.id)] ?? ""}
                    onChange={(e) =>
                      setPerGroup((prev) => ({
                        ...prev,
                        [String(gg.id)]: e.target.value,
                      }))
                    }
                    type="number"
                    placeholder="不限"
                    className="flex-1"
                  />
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

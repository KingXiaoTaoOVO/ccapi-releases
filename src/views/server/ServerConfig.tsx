import { useCallback, useEffect, useState } from "react";
import { Database, KeyRound, Save, Server, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { apiGet, apiPatch } from "@/services/apiClient";
import { notify } from "@/services/notify";
import { confirm } from "@/store/useConfirmStore";
import { prompt } from "@/store/usePromptStore";
import { DangerZone } from "@/views/server/DangerZone";
import {
  changeEntryPassword,
  readServerLocalConfig,
  testMysqlConnection,
  testRedisConnection,
  writeServerLocalConfig,
} from "@/services/tauri";
import type { ServerLocalConfig } from "@/types/auth";

interface BizConfig {
  invite_reward_usd?: { inviter: number; invitee: number };
  default_signup_bonus_usd?: number | string;
  rate_limit_codes_enabled?: { enabled: boolean };
  rate_limit_global_enabled?: { enabled: boolean };
  login_rate_per_minute?: number | string;
  api_rate_per_minute?: number | string;
  [k: string]: any;
}

export function ServerConfig() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 12 });
  const [local, setLocal] = useState<ServerLocalConfig | null>(null);
  const [biz, setBiz] = useState<BizConfig>({});
  const [savingLocal, setSavingLocal] = useState(false);
  const [savingBiz, setSavingBiz] = useState(false);

  const load = useCallback(async () => {
    const l = await readServerLocalConfig();
    setLocal(l);
    try {
      const b = await apiGet<{ config: BizConfig }>("/api/admin/config");
      setBiz(b.config);
    } catch (e: any) {
      notify("error", "加载业务配置失败", e?.message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!local) {
    return (
      <div className="grid h-full place-items-center text-xs text-muted">
        {t("common.loading")}
      </div>
    );
  }

  const saveLocal = async () => {
    if (
      !(await confirm({
        title: t("admin.cfg.localConfirmTitle"),
        description: t("admin.cfg.localConfirmDesc"),
        level: "danger",
      }))
    )
      return;
    setSavingLocal(true);
    try {
      await writeServerLocalConfig(local);
      notify("success", t("admin.cfg.savedLocal"), t("admin.cfg.restartHint"));
    } catch (e: any) {
      notify("error", "保存失败", e?.message);
    } finally {
      setSavingLocal(false);
    }
  };

  const saveBiz = async () => {
    setSavingBiz(true);
    try {
      await apiPatch("/api/admin/config", biz);
      notify("success", t("admin.cfg.savedBiz"));
    } catch (e: any) {
      notify("error", "保存失败", e?.message);
    } finally {
      setSavingBiz(false);
    }
  };

  const changePw = async () => {
    const r = await prompt({
      title: t("admin.cfg.changeEntry"),
      description: t("admin.cfg.entryConfirmTitle"),
      danger: true,
      fields: [
        {
          name: "oldPw",
          label: t("admin.cfg.entryOld"),
          placeholder: t("admin.cfg.entryOld.ph"),
          type: "password",
          required: true,
        },
        {
          name: "newPw",
          label: t("admin.cfg.entryNew"),
          placeholder: t("admin.cfg.entryNew.ph"),
          type: "password",
          required: true,
          validate: (v) =>
            v.length < 4 ? t("admin.cfg.entryShort") : null,
        },
      ],
    });
    if (!r) return;
    try {
      await changeEntryPassword(r.oldPw, r.newPw);
      notify("success", t("admin.cfg.entryDone"));
    } catch (e: any) {
      notify("error", "修改失败", e?.message);
    }
  };

  return (
    <div ref={ref} className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <header>
          <h1 className="text-xl font-semibold">{t("admin.cfg.title")}</h1>
          <p className="mt-1 text-sm text-muted">{t("admin.cfg.subtitle")}</p>
        </header>

        {/* 本地配置 */}
        <section className="rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Server className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold">{t("admin.cfg.local")}</h2>
            </div>
            <Button size="sm" onClick={() => void saveLocal()} loading={savingLocal}>
              <Save className="h-3.5 w-3.5" />
              {t("common.save")}
            </Button>
          </div>

          <p className="mb-4 flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            {t("admin.cfg.localWarn")}
          </p>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <TextField
              label="MySQL Host"
              value={local.mysql.host}
              onChange={(e) =>
                setLocal({ ...local, mysql: { ...local.mysql, host: e.target.value } })
              }
            />
            <TextField
              label="MySQL Port"
              type="number"
              value={local.mysql.port}
              onChange={(e) =>
                setLocal({
                  ...local,
                  mysql: { ...local.mysql, port: Number(e.target.value) || 0 },
                })
              }
            />
            <TextField
              label="MySQL User"
              value={local.mysql.user}
              onChange={(e) =>
                setLocal({ ...local, mysql: { ...local.mysql, user: e.target.value } })
              }
            />
            <TextField
              label="MySQL Password"
              type="password"
              value={local.mysql.password}
              onChange={(e) =>
                setLocal({
                  ...local,
                  mysql: { ...local.mysql, password: e.target.value },
                })
              }
            />
            <TextField
              label="Database"
              value={local.mysql.database}
              onChange={(e) =>
                setLocal({
                  ...local,
                  mysql: { ...local.mysql, database: e.target.value },
                })
              }
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={async () => {
                try {
                  await testMysqlConnection(local.mysql);
                  notify("success", "MySQL OK");
                } catch (e: any) {
                  notify("error", "MySQL", e?.message);
                }
              }}
              className="mt-auto"
            >
              <Database className="h-3.5 w-3.5" />
              {t("server.init.test")}
            </Button>

            <TextField
              label="Redis Host"
              value={local.redis.host}
              onChange={(e) =>
                setLocal({ ...local, redis: { ...local.redis, host: e.target.value } })
              }
            />
            <TextField
              label="Redis Port"
              type="number"
              value={local.redis.port}
              onChange={(e) =>
                setLocal({
                  ...local,
                  redis: { ...local.redis, port: Number(e.target.value) || 0 },
                })
              }
            />
            <TextField
              label="Redis Password"
              type="password"
              value={local.redis.password ?? ""}
              onChange={(e) =>
                setLocal({
                  ...local,
                  redis: {
                    ...local.redis,
                    password: e.target.value || null,
                  },
                })
              }
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={async () => {
                try {
                  await testRedisConnection(local.redis);
                  notify("success", "Redis OK");
                } catch (e: any) {
                  notify("error", "Redis", e?.message);
                }
              }}
              className="mt-auto"
            >
              <Database className="h-3.5 w-3.5" />
              {t("server.init.test")}
            </Button>

            <TextField
              label={t("admin.cfg.listenIp")}
              value={local.listenIp}
              onChange={(e) => setLocal({ ...local, listenIp: e.target.value })}
            />
            <TextField
              label={t("admin.cfg.listenPort")}
              type="number"
              value={local.listenPort}
              onChange={(e) =>
                setLocal({ ...local, listenPort: Number(e.target.value) || 8787 })
              }
            />
          </div>

          <div className="mt-4 border-t border-border pt-4">
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-warning" />
              <span className="text-sm font-semibold">
                {t("admin.cfg.entryPassword")}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted">{t("admin.cfg.entryHint")}</p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-2"
              onClick={() => void changePw()}
            >
              {t("admin.cfg.changeEntry")}
            </Button>
          </div>
        </section>

        {/* 业务配置 */}
        <section className="rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold">{t("admin.cfg.biz")}</h2>
            <Button size="sm" onClick={() => void saveBiz()} loading={savingBiz}>
              <Save className="h-3.5 w-3.5" />
              {t("common.save")}
            </Button>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <TextField
              label={t("admin.cfg.signupBonus")}
              type="number"
              value={
                typeof biz.default_signup_bonus_usd === "string"
                  ? biz.default_signup_bonus_usd
                  : biz.default_signup_bonus_usd ?? 10
              }
              onChange={(e) =>
                setBiz({
                  ...biz,
                  default_signup_bonus_usd: Number(e.target.value) || 0,
                })
              }
              hint="USD"
            />
            <TextField
              label={t("admin.cfg.inviteInviter")}
              type="number"
              value={biz.invite_reward_usd?.inviter ?? 10}
              onChange={(e) =>
                setBiz({
                  ...biz,
                  invite_reward_usd: {
                    inviter: Number(e.target.value) || 0,
                    invitee: biz.invite_reward_usd?.invitee ?? 10,
                  },
                })
              }
              hint="USD"
            />
            <TextField
              label={t("admin.cfg.inviteInvitee")}
              type="number"
              value={biz.invite_reward_usd?.invitee ?? 10}
              onChange={(e) =>
                setBiz({
                  ...biz,
                  invite_reward_usd: {
                    inviter: biz.invite_reward_usd?.inviter ?? 10,
                    invitee: Number(e.target.value) || 0,
                  },
                })
              }
              hint="USD"
            />
            <TextField
              label={t("admin.cfg.loginRpm")}
              type="number"
              value={Number(biz.login_rate_per_minute ?? 5)}
              onChange={(e) =>
                setBiz({ ...biz, login_rate_per_minute: Number(e.target.value) || 0 })
              }
            />
            <TextField
              label={t("admin.cfg.apiRpm")}
              type="number"
              value={Number(biz.api_rate_per_minute ?? 60)}
              onChange={(e) =>
                setBiz({ ...biz, api_rate_per_minute: Number(e.target.value) || 0 })
              }
            />
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <ToggleRow
              label={t("admin.cfg.globalLimit")}
              value={biz.rate_limit_global_enabled?.enabled ?? true}
              onChange={(v) =>
                setBiz({ ...biz, rate_limit_global_enabled: { enabled: v } })
              }
            />
            <ToggleRow
              label={t("admin.cfg.codeLimit")}
              value={biz.rate_limit_codes_enabled?.enabled ?? false}
              onChange={(v) =>
                setBiz({ ...biz, rate_limit_codes_enabled: { enabled: v } })
              }
            />
          </div>
        </section>

        <DangerZone />
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex flex-1 cursor-pointer items-center gap-2 rounded-xl border border-border bg-surface-2/40 px-3 py-2.5 text-xs">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 rounded accent-primary"
      />
      {label}
    </label>
  );
}

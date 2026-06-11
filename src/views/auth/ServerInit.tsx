import { useEffect, useState } from "react";
import { CheckCircle2, Database, Loader2, RefreshCw, ServerCog, XCircle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { notify } from "@/services/notify";
import {
  initDatabase,
  readServerLocalConfig,
  resetDatabase,
  startAdminServer,
  testMysqlConnection,
  testRedisConnection,
  writeServerLocalConfig,
} from "@/services/tauri";
import { configureApiClient } from "@/services/apiClient";
import { confirm } from "@/store/useConfirmStore";
import type { ServerLocalConfig } from "@/types/auth";
import { cn } from "@/lib/cn";

interface Props {
  onReady: (boundUrl: string) => void;
}

type TestState = "idle" | "testing" | "ok" | "fail";

export function ServerInit({ onReady }: Props) {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 16 });
  const [cfg, setCfg] = useState<ServerLocalConfig | null>(null);
  const [mysql, setMysql] = useState<TestState>("idle");
  const [redis, setRedis] = useState<TestState>("idle");
  const [initing, setIniting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    void (async () => {
      const c = await readServerLocalConfig();
      setCfg(c);
    })();
  }, []);

  if (!cfg) {
    return (
      <div className="grid h-full place-items-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted" />
      </div>
    );
  }

  const update = (patch: Partial<ServerLocalConfig>) =>
    setCfg((c) => (c ? { ...c, ...patch } : c));

  const updateMysql = (patch: Partial<ServerLocalConfig["mysql"]>) =>
    setCfg((c) => (c ? { ...c, mysql: { ...c.mysql, ...patch } } : c));

  const updateRedis = (patch: Partial<ServerLocalConfig["redis"]>) =>
    setCfg((c) => (c ? { ...c, redis: { ...c.redis, ...patch } } : c));

  const saveCfg = async () => writeServerLocalConfig(cfg);

  const doTestMysql = async () => {
    setMysql("testing");
    try {
      await testMysqlConnection(cfg.mysql);
      setMysql("ok");
    } catch (e: any) {
      setMysql("fail");
      notify("error", "MySQL", e?.message ?? String(e));
    }
  };

  const doTestRedis = async () => {
    setRedis("testing");
    try {
      await testRedisConnection(cfg.redis);
      setRedis("ok");
    } catch (e: any) {
      setRedis("fail");
      notify("error", "Redis", e?.message ?? String(e));
    }
  };

  const doInitDb = async () => {
    setIniting(true);
    try {
      await saveCfg();
      const report = await initDatabase();
      notify(
        "success",
        t("server.init.dbDone"),
        t("server.init.dbDoneDesc", {
          n: report.statementsExecuted,
        }),
      );
      const c = await readServerLocalConfig();
      setCfg(c);
    } catch (e: any) {
      notify("error", t("server.init.dbFailTitle"), e?.message ?? String(e));
    } finally {
      setIniting(false);
    }
  };

  const doResetDb = async () => {
    if (
      !(await confirm({
        title: t("server.init.resetConfirmTitle"),
        description: t("server.init.resetConfirmDesc"),
        level: "critical",
        confirmText: "RESET",
      }))
    )
      return;
    setResetting(true);
    try {
      await saveCfg();
      const report = await resetDatabase();
      notify(
        "success",
        t("server.init.resetDone"),
        t("server.init.dbDoneDesc", { n: report.statementsExecuted }),
      );
      const c = await readServerLocalConfig();
      setCfg(c);
    } catch (e: any) {
      notify("error", t("server.init.resetFailTitle"), e?.message ?? String(e));
    } finally {
      setResetting(false);
    }
  };

  const doStart = async () => {
    setStarting(true);
    try {
      await saveCfg();
      const status = await startAdminServer();
      const url = `http://${status.boundAddress}`;
      configureApiClient({ baseUrl: url });
      notify("success", t("server.init.startedTitle"), url);
      onReady(url);
    } catch (e: any) {
      notify("error", t("server.init.startFailTitle"), e?.message ?? String(e));
    } finally {
      setStarting(false);
    }
  };

  const canInit = mysql === "ok" && redis === "ok";

  return (
    <div ref={ref} className="h-full overflow-y-auto px-6 py-8">
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <header className="space-y-2">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-border bg-surface shadow-glow">
            <ServerCog className="h-6 w-6 text-primary" />
          </div>
          <h1 className="text-xl font-semibold">{t("server.init.title")}</h1>
          <p className="text-sm text-muted">{t("server.init.subtitle")}</p>
        </header>

        {/* MySQL */}
        <section className="rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold">{t("server.init.mysql")}</h2>
            </div>
            <TestPill state={mysql} />
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <TextField
              label={t("server.init.host")}
              value={cfg.mysql.host}
              onChange={(e) => {
                updateMysql({ host: e.target.value });
                setMysql("idle");
              }}
            />
            <TextField
              label={t("server.init.port")}
              type="number"
              value={cfg.mysql.port}
              onChange={(e) => {
                updateMysql({ port: Number(e.target.value) || 0 });
                setMysql("idle");
              }}
            />
            <TextField
              label={t("server.init.user")}
              value={cfg.mysql.user}
              onChange={(e) => {
                updateMysql({ user: e.target.value });
                setMysql("idle");
              }}
            />
            <TextField
              label={t("server.init.password")}
              type="password"
              value={cfg.mysql.password}
              onChange={(e) => {
                updateMysql({ password: e.target.value });
                setMysql("idle");
              }}
            />
            <TextField
              label={t("server.init.database")}
              value={cfg.mysql.database}
              onChange={(e) => updateMysql({ database: e.target.value })}
              className="md:col-span-2"
            />
          </div>
          <div className="mt-4 flex justify-end">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void doTestMysql()}
              loading={mysql === "testing"}
            >
              {t("server.init.test")}
            </Button>
          </div>
        </section>

        {/* Redis */}
        <section className="rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-info" />
              <h2 className="text-sm font-semibold">{t("server.init.redis")}</h2>
            </div>
            <TestPill state={redis} />
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <TextField
              label={t("server.init.host")}
              value={cfg.redis.host}
              onChange={(e) => {
                updateRedis({ host: e.target.value });
                setRedis("idle");
              }}
            />
            <TextField
              label={t("server.init.port")}
              type="number"
              value={cfg.redis.port}
              onChange={(e) => {
                updateRedis({ port: Number(e.target.value) || 0 });
                setRedis("idle");
              }}
            />
            <TextField
              label={t("server.init.redisPassword")}
              type="password"
              value={cfg.redis.password ?? ""}
              onChange={(e) =>
                updateRedis({
                  password: e.target.value ? e.target.value : null,
                })
              }
            />
            <TextField
              label={t("server.init.redisDb")}
              type="number"
              value={cfg.redis.db}
              onChange={(e) => updateRedis({ db: Number(e.target.value) || 0 })}
            />
          </div>
          <div className="mt-4 flex justify-end">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void doTestRedis()}
              loading={redis === "testing"}
            >
              {t("server.init.test")}
            </Button>
          </div>
        </section>

        {/* 监听 */}
        <section className="rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
          <h2 className="mb-4 text-sm font-semibold">
            {t("server.init.listen")}
          </h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <TextField
              label="IP"
              value={cfg.listenIp}
              onChange={(e) => update({ listenIp: e.target.value })}
              hint={t("server.init.listenHint")}
            />
            <TextField
              label="Port"
              type="number"
              value={cfg.listenPort}
              onChange={(e) =>
                update({ listenPort: Number(e.target.value) || 8787 })
              }
            />
          </div>
        </section>

        {/* 操作 */}
        <section className="flex flex-col gap-3 rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
          <div className="flex flex-col gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">
                {t("server.init.actions")}
              </h2>
              <p className="mt-1 text-xs text-muted">
                {t("server.init.actionsHint")}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void doResetDb()}
                disabled={!canInit}
                loading={resetting}
                className="shrink-0 whitespace-nowrap text-danger hover:text-danger"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {t("server.init.resetDb")}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void doInitDb()}
                disabled={!canInit}
                loading={initing}
                className="shrink-0 whitespace-nowrap"
              >
                {t("server.init.initDb")}
              </Button>
              <Button
                size="sm"
                onClick={() => void doStart()}
                disabled={!cfg.initialized}
                loading={starting}
                className="shrink-0 whitespace-nowrap"
              >
                {t("server.init.start")}
              </Button>
            </div>
          </div>
          {cfg.initialized && (
            <div className="flex items-center gap-2 text-xs text-success">
              <CheckCircle2 className="h-3.5 w-3.5" />
              {t("server.init.alreadyInitialized")}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function TestPill({ state }: { state: TestState }) {
  if (state === "idle") return null;
  const conf = {
    testing: { cls: "text-muted", Icon: Loader2, label: "测试中…", spin: true },
    ok: { cls: "text-success", Icon: CheckCircle2, label: "连接正常" },
    fail: { cls: "text-danger", Icon: XCircle, label: "连接失败" },
  }[state]!;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 text-xs",
        conf.cls,
      )}
    >
      <conf.Icon
        className={cn("h-3 w-3", "spin" in conf && conf.spin && "animate-spin")}
      />
      {conf.label}
    </span>
  );
}

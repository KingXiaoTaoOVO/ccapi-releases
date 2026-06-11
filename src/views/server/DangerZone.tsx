import { useState } from "react";
import { AlertTriangle, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { useT } from "@/i18n";
import { apiDelete } from "@/services/apiClient";
import { notify } from "@/services/notify";
import { confirm } from "@/store/useConfirmStore";

type Scope = "invitations" | "logs" | "usage";
type Range = "all" | "1d" | "7d" | "30d" | "90d";

interface Endpoint {
  path: string;
  /** ConfirmDialog 输入串 */
  phrase: string;
}

const SCOPES: Record<
  Scope,
  Endpoint & {
    /** i18n key 前缀，例 "danger.invites" */
    keyPrefix: string;
  }
> = {
  invitations: {
    path: "/api/admin/invitations",
    phrase: "DELETE INVITATIONS",
    keyPrefix: "danger.invites",
  },
  logs: {
    path: "/api/admin/logs",
    phrase: "DELETE LOGS",
    keyPrefix: "danger.logs",
  },
  usage: {
    path: "/api/admin/usage",
    phrase: "DELETE USAGE",
    keyPrefix: "danger.usage",
  },
};

function rangeToBeforeTs(r: Range): number | null {
  if (r === "all") return null;
  const days = { "1d": 1, "7d": 7, "30d": 30, "90d": 90 }[r];
  return Math.floor(Date.now() / 1000) - days * 86400;
}

interface RowProps {
  scope: Scope;
  onDone: () => void;
}

function PurgeRow({ scope, onDone }: RowProps) {
  const t = useT();
  const { path, phrase, keyPrefix } = SCOPES[scope];
  const [range, setRange] = useState<Range>("90d");
  const [busy, setBusy] = useState(false);

  const exec = async () => {
    const beforeTs = rangeToBeforeTs(range);
    const rangeLabel = t(`danger.range.${range}` as never);
    const ok = await confirm({
      title: t(`${keyPrefix}.confirmTitle` as never, { range: rangeLabel }),
      description: t(`${keyPrefix}.confirmDesc` as never, { range: rangeLabel }),
      level: "critical",
      confirmText: phrase,
      confirmLabel: t("danger.confirmBtn"),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const qs = beforeTs != null ? `?beforeTs=${beforeTs}` : "";
      const r = await apiDelete<{ ok: true; deleted: number }>(path + qs);
      notify(
        "success",
        t("danger.done"),
        t("danger.deletedRows", { n: String(r.deleted) }),
      );
      onDone();
    } catch (e: any) {
      notify("error", t("danger.fail"), e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-3 rounded-xl border border-border bg-surface-2/40 p-3 sm:grid-cols-[1fr,160px,auto]">
      <div className="min-w-0">
        <p className="text-sm font-medium">{t(`${keyPrefix}.title` as never)}</p>
        <p className="mt-0.5 text-xs text-muted">
          {t(`${keyPrefix}.desc` as never)}
        </p>
      </div>
      <Select
        value={range}
        onValueChange={(v) => setRange(v as Range)}
        options={[
          { value: "1d", label: t("danger.range.1d") },
          { value: "7d", label: t("danger.range.7d") },
          { value: "30d", label: t("danger.range.30d") },
          { value: "90d", label: t("danger.range.90d") },
          { value: "all", label: t("danger.range.all") },
        ]}
      />
      <Button
        variant="ghost"
        onClick={() => void exec()}
        loading={busy}
        className="text-danger hover:bg-danger/10"
      >
        <Trash2 className="h-3.5 w-3.5" />
        {t("danger.purgeBtn")}
      </Button>
    </div>
  );
}

export function DangerZone() {
  const t = useT();
  const [tick, setTick] = useState(0);
  const onDone = () => setTick((x) => x + 1);

  return (
    <section className="rounded-2xl border border-danger/40 bg-danger/5 p-5 backdrop-blur-xl">
      <header className="mb-3 flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-danger" />
        <h2 className="text-sm font-semibold text-danger">
          {t("danger.title")}
        </h2>
      </header>
      <p className="mb-4 text-xs leading-relaxed text-muted">
        {t("danger.intro")}
      </p>
      <div className="space-y-3" key={tick}>
        <PurgeRow scope="invitations" onDone={onDone} />
        <PurgeRow scope="logs" onDone={onDone} />
        <PurgeRow scope="usage" onDone={onDone} />
      </div>
    </section>
  );
}

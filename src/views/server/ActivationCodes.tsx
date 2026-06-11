import { useCallback, useEffect, useState } from "react";
import {
  Download,
  FileSpreadsheet,
  FileText,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { TextField, TextArea } from "@/components/ui/TextField";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { cn } from "@/lib/cn";
import { apiDelete, apiGet, apiPost } from "@/services/apiClient";
import { notify } from "@/services/notify";
import { confirm } from "@/store/useConfirmStore";
import { useAuthStore } from "@/store/useAuthStore";
import { useModeStore } from "@/store/useModeStore";

interface CodeRow {
  id: number;
  code: string;
  codeType: "role" | "quota_usd" | "quota_token";
  payload: Record<string, any>;
  expiresAt: string | null;
  redeemedBy: number | null;
  redeemedAt: string | null;
  batchId: string | null;
  createdAt: string | null;
}

interface Tier {
  id: number;
  code: string;
  displayName: string;
}

const TYPE_LABEL: Record<CodeRow["codeType"], string> = {
  role: "角色档位",
  quota_usd: "USD 额度",
  quota_token: "Token 额度",
};

export function ActivationCodes() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 12 });
  const [codes, setCodes] = useState<CodeRow[]>([]);
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [type, setType] = useState("");
  const [redeemed, setRedeemed] = useState("");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (type) params.set("codeType", type);
      if (redeemed) params.set("redeemed", redeemed);
      const data = await apiGet<{ codes: CodeRow[] }>(
        `/api/admin/codes?${params}`,
      );
      let list = data.codes;
      if (search) {
        list = list.filter(
          (c) =>
            c.code.includes(search.toUpperCase()) ||
            (c.batchId ?? "").includes(search),
        );
      }
      setCodes(list);
    } catch (e: any) {
      notify("error", "加载失败", e?.message);
    } finally {
      setLoading(false);
    }
  }, [type, redeemed, search]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void apiGet<{ tiers: Tier[] }>("/api/admin/tiers").then((d) =>
      setTiers(d.tiers),
    );
  }, []);

  const exportFile = async (format: "xlsx" | "csv" | "txt") => {
    setDownloading(true);
    try {
      const url = `${useModeStore.getState().serverUrl ?? ""}/api/admin/codes/export?format=${format}`;
      const token = useAuthStore.getState().session?.tokens.accessToken;
      const resp = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const obj = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = obj;
      a.download = `ccapi-codes.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(obj);
      notify("success", t("admin.codes.exported"));
    } catch (e: any) {
      notify("error", "导出失败", e?.message);
    } finally {
      setDownloading(false);
    }
  };

  const del = async (c: CodeRow) => {
    if (
      !(await confirm({
        title: t("admin.codes.delTitle"),
        level: "danger",
      }))
    )
      return;
    try {
      await apiDelete(`/api/admin/codes/${c.id}`);
      notify("success", t("admin.codes.delDone"));
      await load();
    } catch (e: any) {
      notify("error", "删除失败", e?.message);
    }
  };

  return (
    <div ref={ref} className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border/60 px-6 py-4">
        <label className="relative flex h-10 min-w-[200px] flex-1 items-center sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 h-4 w-4 text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("admin.codes.search")}
            className="no-drag h-10 w-full rounded-xl border border-border bg-surface-2 pl-9 pr-3 text-sm focus:border-primary/60 focus:shadow-[0_0_0_3px_rgb(var(--primary)/0.18)] focus:outline-none"
          />
        </label>
        <Select
          value={type}
          onValueChange={setType}
          options={[
            { value: "", label: t("admin.codes.allTypes") },
            { value: "role", label: TYPE_LABEL.role },
            { value: "quota_usd", label: TYPE_LABEL.quota_usd },
            { value: "quota_token", label: TYPE_LABEL.quota_token },
          ]}
        />
        <Select
          value={redeemed}
          onValueChange={setRedeemed}
          options={[
            { value: "", label: t("admin.codes.all") },
            { value: "false", label: t("admin.codes.unused") },
            { value: "true", label: t("admin.codes.used") },
          ]}
        />
        <Button size="sm" variant="secondary" onClick={() => void load()} loading={loading}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void exportFile("xlsx")}
          loading={downloading}
          title="Excel"
        >
          <FileSpreadsheet className="h-3.5 w-3.5" />
          xlsx
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void exportFile("csv")}
          loading={downloading}
        >
          <Download className="h-3.5 w-3.5" />
          csv
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void exportFile("txt")}
          loading={downloading}
        >
          <FileText className="h-3.5 w-3.5" />
          txt
        </Button>
        <Button size="sm" onClick={() => setCreating(true)} className="ml-auto">
          <Plus className="h-4 w-4" />
          {t("admin.codes.generate")}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <div className="overflow-hidden rounded-2xl border border-border bg-surface/40">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-xs text-muted">
              <tr>
                <th className="px-3 py-2.5 text-left">Code</th>
                <th className="px-3 py-2.5 text-left">{t("admin.codes.col.type")}</th>
                <th className="px-3 py-2.5 text-left">{t("admin.codes.col.payload")}</th>
                <th className="px-3 py-2.5 text-left">{t("admin.codes.col.batch")}</th>
                <th className="px-3 py-2.5 text-left">{t("admin.codes.col.status")}</th>
                <th className="px-3 py-2.5 text-right">{t("admin.users.col.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {codes.map((c) => (
                <tr key={c.id} className="border-t border-border/40">
                  <td className="px-3 py-2.5 font-mono text-xs">{c.code}</td>
                  <td className="px-3 py-2.5 text-xs">{TYPE_LABEL[c.codeType]}</td>
                  <td className="px-3 py-2.5 text-xs text-muted">
                    {JSON.stringify(c.payload)}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted">{c.batchId}</td>
                  <td className="px-3 py-2.5 text-xs">
                    {c.redeemedBy ? (
                      <span className="rounded-full bg-success/15 px-2 py-0.5 text-success">
                        {t("admin.codes.usedBy")} #{c.redeemedBy}
                      </span>
                    ) : (
                      <span className="rounded-full bg-surface-2 px-2 py-0.5 text-muted">
                        {t("admin.codes.unused")}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <button
                      onClick={() => void del(c)}
                      className="rounded-lg border border-border/60 px-2 py-1 text-xs text-muted hover:border-danger/60 hover:text-danger"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
              {codes.length === 0 && !loading && (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-xs text-muted">
                    {t("admin.codes.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <GenerateModal
        open={creating}
        onClose={() => setCreating(false)}
        tiers={tiers}
        onGenerated={() => {
          setCreating(false);
          void load();
        }}
      />
    </div>
  );
}

function GenerateModal({
  open,
  onClose,
  tiers,
  onGenerated,
}: {
  open: boolean;
  onClose: () => void;
  tiers: Tier[];
  onGenerated: () => void;
}) {
  const t = useT();
  const [type, setType] = useState<"role" | "quota_usd" | "quota_token">("role");
  const [count, setCount] = useState(10);
  const [tierCode, setTierCode] = useState(tiers[0]?.code ?? "pro");
  const [days, setDays] = useState(30);
  const [amountUsd, setAmountUsd] = useState(10);
  const [equivUsd, setEquivUsd] = useState(5);
  const [allowedModels, setAllowedModels] = useState("");
  const [rateLimit, setRateLimit] = useState(false);
  const [expires, setExpires] = useState("");
  const [saving, setSaving] = useState(false);
  const [generatedCodes, setGeneratedCodes] = useState<string[] | null>(null);

  useEffect(() => {
    if (open) {
      setGeneratedCodes(null);
      if (tiers[0]) setTierCode(tiers[0].code);
    }
  }, [open, tiers]);

  const submit = async () => {
    setSaving(true);
    try {
      const payload: any = {
        rateLimitEnabled: rateLimit,
      };
      if (allowedModels.trim()) {
        payload.allowedModels = allowedModels.split(/[,\s]+/).filter(Boolean);
      }
      if (type === "role") {
        payload.tierCode = tierCode;
        payload.durationDays = days;
      } else if (type === "quota_usd") {
        payload.amountUsd = amountUsd;
      } else {
        payload.equivUsd = equivUsd;
      }
      const body = {
        count,
        codeType: type,
        payload,
        expiresAt: expires ? new Date(expires).toISOString() : null,
      };
      const r = await apiPost<{ codes: string[]; batchId: string }>(
        "/api/admin/codes",
        body,
      );
      notify(
        "success",
        t("admin.codes.generated", { n: r.codes.length, batch: r.batchId }),
      );
      setGeneratedCodes(r.codes);
    } catch (e: any) {
      notify("error", "生成失败", e?.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={t("admin.codes.generateTitle")}
      footer={
        generatedCodes ? (
          <Button
            onClick={() => {
              setGeneratedCodes(null);
              onGenerated();
            }}
          >
            {t("admin.codes.done")}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void submit()} loading={saving}>
              {t("admin.codes.generate")}
            </Button>
          </>
        )
      }
    >
      {generatedCodes ? (
        <div className="space-y-3">
          <p className="text-sm">
            {t("admin.codes.generatedCount", { n: generatedCodes.length })}
          </p>
          <TextArea
            rows={10}
            readOnly
            value={generatedCodes.join("\n")}
            className="font-mono text-xs"
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(generatedCodes.join("\n"));
              notify("success", t("admin.codes.copied"));
            }}
          >
            {t("admin.codes.copyAll")}
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <Select
            label={t("admin.codes.col.type")}
            value={type}
            onValueChange={(v) => setType(v as any)}
            options={[
              { value: "role", label: TYPE_LABEL.role },
              { value: "quota_usd", label: TYPE_LABEL.quota_usd },
              { value: "quota_token", label: TYPE_LABEL.quota_token },
            ]}
          />
          <TextField
            label={t("admin.codes.count")}
            type="number"
            value={count}
            onChange={(e) => setCount(Math.min(10000, Math.max(1, Number(e.target.value) || 1)))}
            hint={t("admin.codes.countHint")}
          />
          {type === "role" && (
            <>
              <Select
                label={t("admin.codes.tier")}
                value={tierCode}
                onValueChange={setTierCode}
                options={tiers.map((tt) => ({ value: tt.code, label: tt.displayName }))}
              />
              <TextField
                label={t("admin.codes.days")}
                type="number"
                value={days}
                onChange={(e) => setDays(Number(e.target.value) || 1)}
              />
            </>
          )}
          {type === "quota_usd" && (
            <TextField
              label={t("admin.codes.amountUsd")}
              type="number"
              value={amountUsd}
              onChange={(e) => setAmountUsd(Number(e.target.value) || 0)}
            />
          )}
          {type === "quota_token" && (
            <TextField
              label={t("admin.codes.equivUsd")}
              type="number"
              value={equivUsd}
              onChange={(e) => setEquivUsd(Number(e.target.value) || 0)}
              hint={t("admin.codes.equivHint")}
            />
          )}
          <TextField
            label={t("admin.codes.allowedModels")}
            value={allowedModels}
            onChange={(e) => setAllowedModels(e.target.value)}
            hint={t("admin.codes.allowedHint")}
          />
          <TextField
            label={t("admin.codes.expiresAt")}
            type="datetime-local"
            value={expires}
            onChange={(e) => setExpires(e.target.value)}
          />
          <label
            className={cn(
              "flex items-center gap-2 rounded-xl border border-border bg-surface-2/40 px-3 py-2.5 text-xs",
            )}
          >
            <input
              type="checkbox"
              checked={rateLimit}
              onChange={(e) => setRateLimit(e.target.checked)}
              className="h-3.5 w-3.5 rounded accent-primary"
            />
            {t("admin.codes.applyRateLimit")}
          </label>
        </div>
      )}
    </Modal>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Tag,
  Trash2,
  XCircle,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { JsonEditor } from "@/components/ui/JsonEditor";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { TextField } from "@/components/ui/TextField";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/services/apiClient";
import { notify } from "@/services/notify";
import { confirm } from "@/store/useConfirmStore";
import { prompt } from "@/store/usePromptStore";

type ChType = "openai" | "anthropic" | "gemini" | "custom" | "local";

interface Channel {
  id: number;
  name: string;
  type: ChType;
  baseUrl: string | null;
  models: string[] | null;
  modelMapping: Record<string, string> | null;
  paramOverride: unknown;
  priority: number;
  weight: number;
  status: number;
  disabledReason: string | null;
  groupId: number | null;
  groupIds: number[] | null;
  keySummary: {
    keyCount: number;
    strategy: string;
    weights: number[];
    failCounts: number[];
    disabled: boolean[];
  } | null;
  autoBan: number;
  failThreshold: number;
  failCount: number;
  lastTestAt: string | null;
  lastTestMs: number | null;
  lastTestOk: number | null;
  tag: string | null;
}

interface UserGroup {
  id: number;
  code: string;
  displayName: string;
}

interface Form {
  name: string;
  type: ChType;
  /** 每行一个 key；为空时编辑不会更新 key */
  keysText: string;
  strategy: "round_robin" | "weighted_random";
  /** 逗号或空格分隔的权重数字 */
  weightsText: string;
  baseUrl: string;
  modelsText: string;
  modelMappingText: string;
  paramOverrideText: string;
  priority: string;
  weight: string;
  failThreshold: string;
  autoBan: boolean;
  status: boolean;
  tag: string;
  groupIds: number[];
}

const EMPTY_FORM: Form = {
  name: "",
  type: "openai",
  keysText: "",
  strategy: "round_robin",
  weightsText: "",
  baseUrl: "",
  modelsText: "",
  modelMappingText: "",
  paramOverrideText: "",
  priority: "0",
  weight: "0",
  failThreshold: "5",
  autoBan: true,
  status: true,
  tag: "",
  groupIds: [],
};

function toForm(ch: Channel): Form {
  return {
    name: ch.name,
    type: ch.type,
    keysText: "",
    strategy:
      (ch.keySummary?.strategy as Form["strategy"]) ?? "round_robin",
    weightsText: ch.keySummary?.weights.join(", ") ?? "",
    baseUrl: ch.baseUrl ?? "",
    modelsText: ch.models ? ch.models.join("\n") : "",
    modelMappingText: ch.modelMapping
      ? JSON.stringify(ch.modelMapping, null, 2)
      : "",
    paramOverrideText: ch.paramOverride
      ? JSON.stringify(ch.paramOverride, null, 2)
      : "",
    priority: String(ch.priority),
    weight: String(ch.weight),
    failThreshold: String(ch.failThreshold),
    autoBan: !!ch.autoBan,
    status: !!ch.status,
    tag: ch.tag ?? "",
    groupIds: ch.groupIds ?? (ch.groupId != null ? [ch.groupId] : []),
  };
}

function StatusDot({ ok }: { ok: number | null }) {
  if (ok == null) return <span className="h-2 w-2 rounded-full bg-muted/40" />;
  return (
    <span
      className={
        "h-2 w-2 rounded-full " + (ok ? "bg-success" : "bg-danger")
      }
    />
  );
}

export function ChannelManager() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 12 });
  const [list, setList] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<Channel | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [groups, setGroups] = useState<UserGroup[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await apiGet<{ channels: Channel[] }>("/api/admin/channels");
      setList(d.channels);
    } catch (e: any) {
      notify("error", t("common.loadFail"), e?.message);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void apiGet<{ groups: UserGroup[] }>("/api/admin/user-groups")
      .then((r) => setGroups(r.groups))
      .catch(() => setGroups([]));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dialogOpen = creating || !!editing;
  const dialogTitle = useMemo(
    () =>
      editing
        ? t("channel.editTitle", { name: editing.name })
        : t("channel.createTitle"),
    [editing, t],
  );

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setFormErr(null);
    setCreating(true);
  };
  const openEdit = (c: Channel) => {
    setForm(toForm(c));
    setFormErr(null);
    setEditing(c);
  };
  const closeDialog = () => {
    setCreating(false);
    setEditing(null);
    setSaving(false);
  };

  const buildBody = (): { body: Record<string, unknown> | null; error: string | null } => {
    if (!form.name.trim()) return { body: null, error: t("channel.err.nameEmpty") };
    const keys = form.keysText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (creating && keys.length === 0)
      return { body: null, error: t("channel.err.keyEmpty") };
    const priority = Number(form.priority);
    const weight = Number(form.weight);
    const failThreshold = Number(form.failThreshold);
    if (!Number.isFinite(priority) || !Number.isFinite(weight) || !Number.isFinite(failThreshold))
      return { body: null, error: t("channel.err.numberInvalid") };
    if (failThreshold < 1)
      return { body: null, error: t("channel.err.failThresholdMin") };
    const models =
      form.modelsText
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0) || null;
    let modelMapping: unknown = null;
    if (form.modelMappingText.trim()) {
      try {
        modelMapping = JSON.parse(form.modelMappingText);
      } catch {
        return { body: null, error: t("channel.err.mappingJson") };
      }
    }
    let paramOverride: unknown = null;
    if (form.paramOverrideText.trim()) {
      try {
        paramOverride = JSON.parse(form.paramOverrideText);
      } catch {
        return { body: null, error: t("channel.err.paramJson") };
      }
    }
    let weights: number[] | undefined;
    if (form.strategy === "weighted_random" && keys.length > 0) {
      const parsed = form.weightsText
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map(Number);
      if (parsed.some((n) => !Number.isFinite(n) || n < 0))
        return { body: null, error: t("channel.err.weightsInvalid") };
      if (parsed.length !== keys.length)
        return { body: null, error: t("channel.err.weightsLength") };
      weights = parsed;
    }
    const body: Record<string, unknown> = {
      name: form.name.trim(),
      type: form.type,
      baseUrl: form.baseUrl.trim() || null,
      models: models.length ? models : null,
      modelMapping,
      paramOverride,
      priority,
      weight,
      status: form.status ? 1 : 0,
      autoBan: form.autoBan ? 1 : 0,
      failThreshold,
      tag: form.tag.trim() || null,
      groupIds: form.groupIds,
    };
    if (keys.length > 0) {
      body.keys = keys;
      body.strategy = form.strategy;
      if (weights) body.weights = weights;
    }
    return { body, error: null };
  };

  const submit = async () => {
    const { body, error } = buildBody();
    if (error || !body) {
      setFormErr(error);
      return;
    }
    setSaving(true);
    setFormErr(null);
    try {
      if (editing) {
        await apiPatch(`/api/admin/channels/${editing.id}`, body);
        notify("success", t("channel.saved", { name: editing.name }));
      } else {
        await apiPost("/api/admin/channels", body);
        notify("success", t("channel.created"));
      }
      closeDialog();
      await load();
    } catch (e: any) {
      setFormErr(e?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async (c: Channel) => {
    const ok = await confirm({
      title: t("channel.delTitle", { name: c.name }),
      description: t("channel.delDesc"),
      level: "critical",
      confirmText: c.name,
    });
    if (!ok) return;
    try {
      await apiDelete(`/api/admin/channels/${c.id}`);
      notify("success", t("channel.delDone"));
      await load();
    } catch (e: any) {
      notify("error", t("channel.delFail"), e?.message);
    }
  };

  const onToggleStatus = async (c: Channel, next: boolean) => {
    setList((xs) => xs.map((x) => (x.id === c.id ? { ...x, status: next ? 1 : 0 } : x)));
    try {
      await apiPatch(`/api/admin/channels/${c.id}`, {
        name: c.name,
        type: c.type,
        baseUrl: c.baseUrl,
        models: c.models,
        modelMapping: c.modelMapping,
        paramOverride: c.paramOverride,
        priority: c.priority,
        weight: c.weight,
        status: next ? 1 : 0,
        autoBan: c.autoBan,
        failThreshold: c.failThreshold,
        tag: c.tag,
        groupIds: c.groupIds ?? (c.groupId != null ? [c.groupId] : []),
      });
    } catch (e: any) {
      setList((xs) => xs.map((x) => (x.id === c.id ? { ...x, status: c.status } : x)));
      notify("error", t("common.saveFail"), e?.message);
    }
  };

  const onTestOne = async (c: Channel) => {
    setTestingId(c.id);
    try {
      const r = await apiPost<{
        ok: boolean;
        httpStatus: number;
        latencyMs: number;
        message: string;
      }>(`/api/admin/channels/${c.id}/test`, {});
      notify(
        r.ok ? "success" : "error",
        r.ok
          ? t("channel.testOk", { ms: String(r.latencyMs) })
          : t("channel.testFail"),
        r.message,
      );
      await load();
    } catch (e: any) {
      notify("error", t("channel.testFail"), e?.message);
    } finally {
      setTestingId(null);
    }
  };

  // 批量
  const toggleSelect = (id: number) => {
    setSelected((s) => {
      const ns = new Set(s);
      if (ns.has(id)) ns.delete(id);
      else ns.add(id);
      return ns;
    });
  };
  const allSelected = list.length > 0 && selected.size === list.length;
  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(list.map((c) => c.id)));
  };

  const batchAction = async (action: "enable" | "disable" | "test" | "delete") => {
    if (selected.size === 0) return;
    if (action === "delete") {
      const ok = await confirm({
        title: t("channel.batchDelTitle", { n: String(selected.size) }),
        description: t("channel.batchDelDesc"),
        level: "critical",
        confirmText: "DELETE CHANNELS",
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const r = await apiPost<{ ok: true; affected?: number; results?: unknown[] }>(
        "/api/admin/channels/batch",
        { ids: Array.from(selected), action },
      );
      notify(
        "success",
        t("channel.batchDone", {
          action: t(`channel.batch.${action}` as never),
          n: String(r.affected ?? r.results?.length ?? 0),
        }),
      );
      setSelected(new Set());
      await load();
    } catch (e: any) {
      notify("error", t("channel.batchFail"), e?.message);
    } finally {
      setBusy(false);
    }
  };

  const batchTag = async () => {
    if (selected.size === 0) return;
    const r = await prompt({
      title: t("channel.batchTagTitle", { n: String(selected.size) }),
      fields: [
        {
          name: "tag",
          label: t("channel.tag"),
          placeholder: t("channel.tag.ph"),
          required: true,
        },
      ],
    });
    if (!r) return;
    setBusy(true);
    try {
      const x = await apiPost<{ affected: number }>("/api/admin/channels/batch", {
        ids: Array.from(selected),
        action: "tag",
        tag: r.tag,
      });
      notify(
        "success",
        t("channel.batchDone", {
          action: t("channel.batch.tag"),
          n: String(x.affected),
        }),
      );
      setSelected(new Set());
      await load();
    } catch (e: any) {
      notify("error", t("channel.batchFail"), e?.message);
    } finally {
      setBusy(false);
    }
  };

  const typeOptions = [
    { value: "openai", label: "OpenAI" },
    { value: "anthropic", label: "Anthropic" },
    { value: "gemini", label: "Gemini" },
    { value: "custom", label: t("channel.type.custom") },
    { value: "local", label: t("channel.type.local") },
  ];

  return (
    <div ref={ref} className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">{t("channel.title")}</h1>
            <p className="mt-1 text-sm text-muted">{t("channel.subtitle")}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
              {t("common.refresh")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void batchAction("test")}
              disabled={busy}
            >
              <Play className="h-3.5 w-3.5" />
              {t("channel.testAll")}
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" />
              {t("channel.create")}
            </Button>
          </div>
        </header>

        {/* 批量操作栏 */}
        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/30 bg-primary/5 p-3 text-xs">
            <span className="text-primary">
              {t("channel.batchSelected", { n: String(selected.size) })}
            </span>
            <Button size="sm" variant="ghost" onClick={() => void batchAction("enable")} disabled={busy}>
              <CheckCircle2 className="h-3.5 w-3.5" />
              {t("channel.batch.enable")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void batchAction("disable")} disabled={busy}>
              <XCircle className="h-3.5 w-3.5" />
              {t("channel.batch.disable")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void batchAction("test")} disabled={busy}>
              <Play className="h-3.5 w-3.5" />
              {t("channel.batch.test")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void batchTag()} disabled={busy}>
              <Tag className="h-3.5 w-3.5" />
              {t("channel.batch.tag")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void batchAction("delete")}
              disabled={busy}
              className="text-danger hover:bg-danger/10"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t("channel.batch.delete")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              {t("channel.batchClear")}
            </Button>
          </div>
        )}

        {/* 列表 */}
        {list.length === 0 && !loading ? (
          <div className="grid place-items-center rounded-2xl border border-dashed border-border bg-surface/40 py-16 text-sm text-muted">
            {t("channel.empty")}
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-border bg-surface/60 backdrop-blur-xl">
            <table className="w-full text-sm">
              <thead className="bg-surface-2/60 text-xs text-muted">
                <tr>
                  <th className="px-3 py-2.5 text-left">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      className="accent-primary"
                    />
                  </th>
                  <th className="px-3 py-2.5 text-left">{t("channel.col.name")}</th>
                  <th className="px-3 py-2.5 text-left">{t("channel.col.type")}</th>
                  <th className="px-3 py-2.5 text-left">{t("channel.col.status")}</th>
                  <th className="px-3 py-2.5 text-left">{t("channel.col.priority")}</th>
                  <th className="px-3 py-2.5 text-left">{t("channel.col.lastTest")}</th>
                  <th className="px-3 py-2.5 text-left">{t("channel.col.tag")}</th>
                  <th className="px-3 py-2.5 text-right">{t("channel.col.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((c) => (
                  <tr key={c.id} className="border-t border-border/60 hover:bg-surface-2/30">
                    <td className="px-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={selected.has(c.id)}
                        onChange={() => toggleSelect(c.id)}
                        className="accent-primary"
                      />
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="font-medium">{c.name}</div>
                      {c.baseUrl && (
                        <div className="font-mono text-[10px] text-muted">
                          {c.baseUrl}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs">{c.type}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={!!c.status}
                          onChange={(v) => void onToggleStatus(c, v)}
                        />
                        <StatusDot ok={c.lastTestOk} />
                      </div>
                      {c.disabledReason && (
                        <div className="mt-1 text-[10px] text-warning">
                          {c.disabledReason}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="font-mono text-xs">
                        {c.priority} / w{c.weight}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      {c.lastTestAt ? (
                        <>
                          <div>{new Date(c.lastTestAt).toLocaleString()}</div>
                          {c.lastTestMs != null && (
                            <div className="text-muted">{c.lastTestMs} ms</div>
                          )}
                        </>
                      ) : (
                        <span className="text-muted">-</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs">{c.tag ?? "-"}</td>
                    <td className="px-3 py-2.5 text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={testingId === c.id}
                          onClick={() => void onTestOne(c)}
                        >
                          <Zap className="h-3.5 w-3.5" />
                          {t("channel.test")}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => openEdit(c)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void onDelete(c)}
                          className="text-danger hover:bg-danger/10"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 新建/编辑 Modal */}
      <Modal
        open={dialogOpen}
        onClose={closeDialog}
        title={dialogTitle}
        description={editing ? t("channel.editDesc") : t("channel.createDesc")}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={closeDialog} disabled={saving}>
              {t("confirm.cancel")}
            </Button>
            <Button onClick={() => void submit()} loading={saving}>
              <Save className="h-3.5 w-3.5" />
              {editing ? t("common.save") : t("channel.create")}
            </Button>
          </>
        }
      >
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <TextField
              label={t("channel.name")}
              value={form.name}
              onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
              placeholder={t("channel.name.ph")}
              required
              autoFocus
            />
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted">
                {t("channel.type")}
              </label>
              <Select
                value={form.type}
                onValueChange={(v) => setForm((s) => ({ ...s, type: v as ChType }))}
                options={typeOptions}
              />
            </div>
          </div>
          <div>
            <label className="mb-1.5 flex items-center justify-between text-xs font-medium text-muted">
              <span>{t("channel.keys")}</span>
              {editing?.keySummary && editing.keySummary.keyCount > 1 && (
                <span className="text-[10px] text-muted/70">
                  {t("channel.keys.current", {
                    n: String(editing.keySummary.keyCount),
                  })}
                </span>
              )}
            </label>
            <textarea
              value={form.keysText}
              onChange={(e) => setForm((s) => ({ ...s, keysText: e.target.value }))}
              placeholder={
                editing ? t("channel.keys.editPh") : t("channel.keys.ph")
              }
              rows={4}
              className="w-full rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 font-mono text-xs outline-none focus:border-primary/60 no-drag"
              spellCheck={false}
            />
            <p className="mt-1 text-[11px] text-muted/80">
              {editing ? t("channel.keys.editHint") : t("channel.keys.hint")}
            </p>
            {/* 单 key 时隐藏策略；多 key 才显示 */}
            <div className="mt-2 grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted">
                  {t("channel.strategy")}
                </label>
                <Select
                  value={form.strategy}
                  onValueChange={(v) =>
                    setForm((s) => ({
                      ...s,
                      strategy: v as Form["strategy"],
                    }))
                  }
                  options={[
                    {
                      value: "round_robin",
                      label: t("channel.strategy.round"),
                    },
                    {
                      value: "weighted_random",
                      label: t("channel.strategy.weighted"),
                    },
                  ]}
                />
              </div>
              {form.strategy === "weighted_random" && (
                <TextField
                  label={t("channel.weights")}
                  value={form.weightsText}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, weightsText: e.target.value }))
                  }
                  placeholder="1, 2, 1"
                  hint={t("channel.weights.hint")}
                />
              )}
            </div>
            {editing?.keySummary && editing.keySummary.keyCount > 1 && (
              <div className="mt-3 flex flex-wrap gap-1.5 text-[10px]">
                {editing.keySummary.disabled.map((d, i) => (
                  <span
                    key={i}
                    className={
                      "rounded-full border px-2 py-0.5 " +
                      (d
                        ? "border-danger/40 bg-danger/10 text-danger"
                        : "border-success/40 bg-success/10 text-success")
                    }
                  >
                    #{i} {d ? t("channel.keys.disabled") : "OK"}（
                    {t("channel.keys.fail", {
                      n: String(editing.keySummary?.failCounts[i] ?? 0),
                    })}
                    ）
                  </span>
                ))}
              </div>
            )}
          </div>
          <TextField
            label={t("channel.baseUrl")}
            value={form.baseUrl}
            onChange={(e) => setForm((s) => ({ ...s, baseUrl: e.target.value }))}
            placeholder={t("channel.baseUrl.ph")}
            hint={t("channel.baseUrl.hint")}
          />
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">
              {t("channel.models")}
            </label>
            <textarea
              value={form.modelsText}
              onChange={(e) => setForm((s) => ({ ...s, modelsText: e.target.value }))}
              placeholder={t("channel.models.ph")}
              rows={3}
              className="w-full rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 font-mono text-xs outline-none focus:border-primary/60 no-drag"
            />
            <p className="mt-1 text-[11px] text-muted/80">{t("channel.models.hint")}</p>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <TextField
              label={t("channel.priority")}
              type="number"
              value={form.priority}
              onChange={(e) => setForm((s) => ({ ...s, priority: e.target.value }))}
            />
            <TextField
              label={t("channel.weight")}
              type="number"
              value={form.weight}
              onChange={(e) => setForm((s) => ({ ...s, weight: e.target.value }))}
            />
            <TextField
              label={t("channel.failThreshold")}
              type="number"
              value={form.failThreshold}
              onChange={(e) => setForm((s) => ({ ...s, failThreshold: e.target.value }))}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <TextField
              label={t("channel.tag")}
              value={form.tag}
              onChange={(e) => setForm((s) => ({ ...s, tag: e.target.value }))}
              placeholder={t("channel.tag.ph")}
            />
            <div className="flex items-end gap-4 pb-1">
              <label className="flex items-center gap-2 text-xs text-muted">
                <Switch
                  checked={form.status}
                  onChange={(v) => setForm((s) => ({ ...s, status: v }))}
                />
                {t("channel.enabled")}
              </label>
              <label className="flex items-center gap-2 text-xs text-muted">
                <Switch
                  checked={form.autoBan}
                  onChange={(v) => setForm((s) => ({ ...s, autoBan: v }))}
                />
                {t("channel.autoBan")}
              </label>
            </div>
          </div>

          {/* 多对多分组 */}
          {groups.length > 0 && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted">
                {t("channel.groups")}
              </label>
              <div className="flex flex-wrap gap-1.5">
                {groups.map((g) => {
                  const on = form.groupIds.includes(g.id);
                  return (
                    <button
                      key={g.id}
                      type="button"
                      onClick={() =>
                        setForm((s) => ({
                          ...s,
                          groupIds: on
                            ? s.groupIds.filter((x) => x !== g.id)
                            : [...s.groupIds, g.id],
                        }))
                      }
                      className={
                        "rounded-full border px-2.5 py-1 text-[11px] transition-colors " +
                        (on
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border bg-surface-2/40 text-muted hover:text-text")
                      }
                    >
                      {g.displayName}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1 text-[11px] text-muted/80">
                {t("channel.groups.hint")}
              </p>
            </div>
          )}
          <details>
            <summary className="cursor-pointer text-xs text-muted hover:text-text">
              {t("channel.advanced")}
            </summary>
            <div className="mt-3 space-y-3">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted">
                  {t("channel.modelMapping")}
                </label>
                <JsonEditor
                  value={form.modelMappingText}
                  onChange={(v) =>
                    setForm((s) => ({ ...s, modelMappingText: v }))
                  }
                  placeholder='{"gpt-4": "claude-3-sonnet"}'
                  rows={3}
                  hint={t("channel.modelMapping.hint")}
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted">
                  {t("channel.paramOverride")}
                </label>
                <JsonEditor
                  value={form.paramOverrideText}
                  onChange={(v) =>
                    setForm((s) => ({ ...s, paramOverrideText: v }))
                  }
                  placeholder='{"temperature": 0.7}'
                  rows={4}
                  hint={t("channel.paramOverride.hint")}
                />
              </div>
            </div>
          </details>
          {formErr && (
            <div className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
              {formErr}
            </div>
          )}
        </form>
      </Modal>
    </div>
  );
}

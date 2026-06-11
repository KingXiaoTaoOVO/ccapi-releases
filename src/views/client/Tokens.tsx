import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  KeyRound,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { TextField } from "@/components/ui/TextField";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/services/apiClient";
import { notify } from "@/services/notify";
import { confirm } from "@/store/useConfirmStore";
import { useModeStore } from "@/store/useModeStore";

interface Token {
  id: number;
  userId: number;
  name: string;
  keyPreview: string;
  quotaUsd: string | null;
  usedUsd: string;
  modelsAllowed: string[] | null;
  ipWhitelist: string[] | null;
  expiresAt: string | null;
  revoked: number;
  lastUsedAt: string | null;
  createdAt: string | null;
}

interface Form {
  name: string;
  quotaUsd: string;
  modelsText: string;
  ipText: string;
  expiresAt: string;
}

const EMPTY: Form = {
  name: "",
  quotaUsd: "",
  modelsText: "",
  ipText: "",
  expiresAt: "",
};

function toForm(t: Token): Form {
  return {
    name: t.name,
    quotaUsd: t.quotaUsd != null ? String(t.quotaUsd) : "",
    modelsText: t.modelsAllowed?.join("\n") ?? "",
    ipText: t.ipWhitelist?.join("\n") ?? "",
    expiresAt: t.expiresAt ? t.expiresAt.slice(0, 16) : "",
  };
}

export function Tokens() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 12 });
  const [list, setList] = useState<Token[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Token | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<Form>(EMPTY);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiGet<{ tokens: Token[] }>("/api/me/tokens");
      setList(r.tokens);
    } catch (e: any) {
      notify("error", t("common.loadFail"), e?.message);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const dialogOpen = creating || !!editing;
  const dialogTitle = useMemo(
    () =>
      editing
        ? t("tokens.editTitle", { name: editing.name })
        : t("tokens.createTitle"),
    [editing, t],
  );

  const openCreate = () => {
    setForm(EMPTY);
    setFormErr(null);
    setCreatedSecret(null);
    setCreating(true);
  };
  const openEdit = (tok: Token) => {
    setForm(toForm(tok));
    setFormErr(null);
    setEditing(tok);
  };
  const closeDialog = () => {
    setCreating(false);
    setEditing(null);
    setSaving(false);
    setCreatedSecret(null);
  };

  const parseList = (s: string): string[] | null => {
    const items = s
      .split(/[\n,]/)
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
    return items.length ? items : null;
  };

  const buildBody = (): { body: Record<string, unknown> | null; error: string | null } => {
    if (!form.name.trim()) return { body: null, error: t("tokens.err.nameEmpty") };
    let quota: number | null = null;
    if (form.quotaUsd.trim()) {
      const q = Number(form.quotaUsd);
      if (!Number.isFinite(q) || q < 0)
        return { body: null, error: t("tokens.err.quotaInvalid") };
      quota = q;
    }
    return {
      body: {
        name: form.name.trim(),
        quotaUsd: quota,
        modelsAllowed: parseList(form.modelsText),
        ipWhitelist: parseList(form.ipText),
        expiresAt: form.expiresAt ? form.expiresAt + ":00" : null,
      },
      error: null,
    };
  };

  const submit = async () => {
    const { body, error } = buildBody();
    if (error || !body) {
      setFormErr(error);
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await apiPatch(`/api/me/tokens/${editing.id}`, body);
        notify("success", t("tokens.saved"));
        closeDialog();
        await load();
      } else {
        const r = await apiPost<{ id: number; token: string; preview: string }>(
          "/api/me/tokens",
          body,
        );
        setCreatedSecret(r.token);
        notify("success", t("tokens.created"));
        await load();
      }
    } catch (e: any) {
      setFormErr(e?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  const onRevoke = async (tok: Token) => {
    const ok = await confirm({
      title: t("tokens.revokeTitle", { name: tok.name }),
      description: t("tokens.revokeDesc"),
      level: "critical",
      confirmText: tok.name,
    });
    if (!ok) return;
    try {
      await apiDelete(`/api/me/tokens/${tok.id}`);
      notify("success", t("tokens.revokeDone"));
      await load();
    } catch (e: any) {
      notify("error", t("tokens.revokeFail"), e?.message);
    }
  };

  const copySecret = async (s: string) => {
    try {
      await navigator.clipboard.writeText(s);
      notify("success", t("tokens.copied"));
    } catch {
      notify("error", t("common.copyFail"));
    }
  };

  return (
    <div ref={ref} className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">{t("tokens.title")}</h1>
            <p className="mt-1 text-sm text-muted">{t("tokens.subtitle")}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
              {t("common.refresh")}
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" />
              {t("tokens.create")}
            </Button>
          </div>
        </header>

        {list.length === 0 && !loading ? (
          <div className="grid place-items-center rounded-2xl border border-dashed border-border bg-surface/40 py-16 text-sm text-muted">
            {t("tokens.empty")}
          </div>
        ) : (
          <div className="space-y-3">
            {list.map((tok) => {
              const limit = tok.quotaUsd ? Number(tok.quotaUsd) : null;
              const used = Number(tok.usedUsd);
              const pct = limit && limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
              return (
                <div
                  key={tok.id}
                  className="rounded-2xl border border-border bg-surface/60 p-4 backdrop-blur-xl"
                >
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
                      <KeyRound className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{tok.name}</span>
                        {tok.revoked ? (
                          <span className="rounded-full bg-danger/15 px-2 py-0.5 text-[10px] text-danger">
                            {t("tokens.revoked")}
                          </span>
                        ) : tok.expiresAt && new Date(tok.expiresAt + "Z") < new Date() ? (
                          <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] text-warning">
                            {t("tokens.expired")}
                          </span>
                        ) : null}
                      </div>
                      <code className="mt-0.5 block font-mono text-[11px] text-muted">
                        {tok.keyPreview}
                      </code>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
                        <span>
                          {t("tokens.used")}: ${used.toFixed(4)}
                          {limit != null && limit > 0 ? ` / $${limit.toFixed(2)}` : ""}
                        </span>
                        {tok.modelsAllowed && tok.modelsAllowed.length > 0 && (
                          <span>
                            {t("tokens.models")}: {tok.modelsAllowed.join(", ")}
                          </span>
                        )}
                        {tok.ipWhitelist && tok.ipWhitelist.length > 0 && (
                          <span>{t("tokens.ips")}: {tok.ipWhitelist.length}</span>
                        )}
                        {tok.expiresAt && (
                          <span>
                            {t("tokens.expiresAt")}:{" "}
                            {new Date(tok.expiresAt + "Z").toLocaleString()}
                          </span>
                        )}
                        {tok.lastUsedAt && (
                          <span>
                            {t("tokens.lastUsed")}:{" "}
                            {new Date(tok.lastUsedAt + "Z").toLocaleString()}
                          </span>
                        )}
                      </div>
                      {limit != null && limit > 0 && (
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
                          <div
                            className="h-full rounded-full bg-primary"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => openEdit(tok)}
                        disabled={!!tok.revoked}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void onRevoke(tok)}
                        disabled={!!tok.revoked}
                        className="text-danger hover:bg-danger/10"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Modal
        open={dialogOpen}
        onClose={closeDialog}
        title={dialogTitle}
        description={editing ? t("tokens.editDesc") : t("tokens.createDesc")}
        size="md"
        disableDismiss={!!createdSecret}
        footer={
          createdSecret ? (
            <Button onClick={closeDialog}>
              <Check className="h-3.5 w-3.5" />
              {t("tokens.gotIt")}
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={closeDialog} disabled={saving}>
                {t("confirm.cancel")}
              </Button>
              <Button onClick={() => void submit()} loading={saving}>
                <Save className="h-3.5 w-3.5" />
                {editing ? t("common.save") : t("tokens.create")}
              </Button>
            </>
          )
        }
      >
        {createdSecret ? (
          <CreatedSecretView token={createdSecret} onCopy={copySecret} />
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <TextField
              label={t("tokens.name")}
              value={form.name}
              onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
              placeholder={t("tokens.name.ph")}
              required
              autoFocus
            />
            <TextField
              label={t("tokens.quota")}
              type="number"
              value={form.quotaUsd}
              onChange={(e) => setForm((s) => ({ ...s, quotaUsd: e.target.value }))}
              placeholder={t("tokens.quota.ph")}
              hint={t("tokens.quota.hint")}
            />
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted">
                {t("tokens.models")}
              </label>
              <textarea
                value={form.modelsText}
                onChange={(e) => setForm((s) => ({ ...s, modelsText: e.target.value }))}
                placeholder={t("tokens.models.ph")}
                rows={3}
                className="w-full rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 font-mono text-xs outline-none focus:border-primary/60 no-drag"
              />
              <p className="mt-1 text-[11px] text-muted/80">{t("tokens.models.hint")}</p>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted">
                {t("tokens.ips")}
              </label>
              <textarea
                value={form.ipText}
                onChange={(e) => setForm((s) => ({ ...s, ipText: e.target.value }))}
                placeholder={t("tokens.ips.ph")}
                rows={3}
                className="w-full rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 font-mono text-xs outline-none focus:border-primary/60 no-drag"
              />
              <p className="mt-1 text-[11px] text-muted/80">{t("tokens.ips.hint")}</p>
            </div>
            <TextField
              label={t("tokens.expiresAt")}
              type="datetime-local"
              value={form.expiresAt}
              onChange={(e) => setForm((s) => ({ ...s, expiresAt: e.target.value }))}
              hint={t("tokens.expiresAt.hint")}
            />
            {formErr && (
              <div className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
                {formErr}
              </div>
            )}
          </form>
        )}
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 创建后明文展示 + 第三方客户端一键导出
// ---------------------------------------------------------------------------

type Preset =
  | "openai-sdk"
  | "anthropic-sdk"
  | "lobe-chat"
  | "opencat"
  | "cherry-studio"
  | "nextchat"
  | "ai-as-workspace"
  | "ama"
  | "raw-json";

function CreatedSecretView({
  token,
  onCopy,
}: {
  token: string;
  onCopy: (s: string) => void;
}) {
  const t = useT();
  const serverUrl = useModeStore((s) => s.serverUrl);
  const base = (serverUrl ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
  const openaiEndpoint = `${base}/api/v1`;
  const anthropicEndpoint = `${base}/api/v1`;
  const [preset, setPreset] = useState<Preset>("openai-sdk");

  const snippet = useMemo(() => buildSnippet(preset, token, openaiEndpoint, anthropicEndpoint), [
    preset,
    token,
    openaiEndpoint,
    anthropicEndpoint,
  ]);

  const presets: { key: Preset; label: string }[] = [
    { key: "openai-sdk", label: "OpenAI SDK (Python)" },
    { key: "anthropic-sdk", label: "Anthropic SDK" },
    { key: "lobe-chat", label: "Lobe Chat" },
    { key: "opencat", label: "OpenCat" },
    { key: "cherry-studio", label: "Cherry Studio" },
    { key: "nextchat", label: "NextChat" },
    { key: "ai-as-workspace", label: "AI as Workspace" },
    { key: "ama", label: "AMA" },
    { key: "raw-json", label: "Raw JSON" },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2.5 text-warning">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <p className="text-xs leading-relaxed">{t("tokens.secretWarn")}</p>
      </div>
      <div className="flex items-center gap-2 rounded-xl border border-border bg-surface-2 p-3">
        <code className="flex-1 break-all font-mono text-xs">{token}</code>
        <Button size="sm" variant="ghost" onClick={() => onCopy(token)}>
          <Copy className="h-3.5 w-3.5" />
          {t("tokens.copy")}
        </Button>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs font-medium text-muted">
            <Package className="h-3.5 w-3.5 text-primary" />
            {t("tokens.export.title")}
          </div>
          <Button size="sm" variant="ghost" onClick={() => onCopy(snippet)}>
            <Copy className="h-3.5 w-3.5" />
            {t("tokens.copy")}
          </Button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {presets.map((p) => (
            <button
              key={p.key}
              onClick={() => setPreset(p.key)}
              className={
                "rounded-full border px-2.5 py-1 text-[11px] transition-colors " +
                (preset === p.key
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-surface-2/40 text-muted hover:text-text")
              }
            >
              {p.label}
            </button>
          ))}
        </div>
        <pre className="max-h-72 overflow-auto rounded-xl border border-border bg-surface-2/60 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
          {snippet}
        </pre>
      </div>
    </div>
  );
}

function buildSnippet(
  preset: Preset,
  token: string,
  openaiBase: string,
  anthropicBase: string,
): string {
  switch (preset) {
    case "openai-sdk":
      return [
        "# Python  (pip install openai)",
        "from openai import OpenAI",
        "",
        `client = OpenAI(`,
        `    base_url="${openaiBase}",`,
        `    api_key="${token}",`,
        `)`,
        "",
        `r = client.chat.completions.create(`,
        `    model="claude-3-5-sonnet-20241022",`,
        `    messages=[{"role": "user", "content": "Hello"}],`,
        `)`,
        "print(r.choices[0].message.content)",
      ].join("\n");
    case "anthropic-sdk":
      return [
        "# Python  (pip install anthropic)",
        "from anthropic import Anthropic",
        "",
        `client = Anthropic(`,
        `    base_url="${anthropicBase}",`,
        `    api_key="${token}",`,
        `)`,
        "",
        `r = client.messages.create(`,
        `    model="claude-3-5-sonnet-20241022",`,
        `    max_tokens=1024,`,
        `    messages=[{"role": "user", "content": "Hello"}],`,
        `)`,
        "print(r.content[0].text)",
      ].join("\n");
    case "lobe-chat":
      // Lobe Chat 通过环境变量或界面"提供商 → 自定义模型"配置
      return [
        "// Lobe Chat — 设置 → 语言模型 → OpenAI",
        "// 1. 启用 OpenAI",
        "// 2. API Key:",
        token,
        "// 3. API 代理地址:",
        openaiBase,
        "// 4. 模型列表（自定义）:",
        "//    claude-3-5-sonnet-20241022, claude-3-5-haiku-20241022, gpt-4o",
        "",
        "// 或写入 .env (自托管 Lobe Chat):",
        `OPENAI_API_KEY=${token}`,
        `OPENAI_PROXY_URL=${openaiBase}`,
      ].join("\n");
    case "opencat":
      return [
        "# OpenCat — Settings → API Provider → Custom",
        "Provider:    OpenAI",
        `API Host:    ${openaiBase}`,
        `API Key:     ${token}`,
        "Models:      claude-3-5-sonnet-20241022 / gpt-4o",
        "",
        "# 或导入 deep link：",
        `opencat://provider/add?type=openai&host=${encodeURIComponent(
          openaiBase,
        )}&apiKey=${encodeURIComponent(token)}`,
      ].join("\n");
    case "cherry-studio":
      return [
        "# Cherry Studio — 设置 → 模型服务 → 添加",
        "服务商类型: OpenAI",
        `API 地址:    ${openaiBase}`,
        `API 密钥:    ${token}`,
        "添加模型:    claude-3-5-sonnet-20241022 / claude-3-5-haiku-20241022 / gpt-4o",
      ].join("\n");
    case "nextchat":
      // NextChat 用 URL query 一键导入
      return [
        "# NextChat — 设置 → 自定义",
        `endpoint=${openaiBase}`,
        `apiKey=${token}`,
        "",
        "# 或访问以下 URL 一键导入（如果你部署在 chat.example.com）：",
        `https://chat.example.com/#/settings?settings=${encodeURIComponent(
          JSON.stringify({
            openaiUrl: openaiBase,
            openaiApiKey: token,
            customModels: "+claude-3-5-sonnet-20241022,+gpt-4o",
          }),
        )}`,
      ].join("\n");
    case "ai-as-workspace":
      // AI as Workspace 通过 Provider Settings 里手动加 OpenAI-compatible endpoint
      return [
        "# AI as Workspace — Settings → Providers → Add custom provider",
        "Provider type: OpenAI Compatible",
        `Base URL:      ${openaiBase}`,
        `API Key:       ${token}`,
        "Model list:    claude-3-5-sonnet-20241022, gpt-4o",
        "",
        "# 或在配置 JSON 中加入：",
        JSON.stringify(
          {
            providers: [
              {
                id: "ccapi",
                name: "CCAPI",
                type: "openai-compatible",
                baseURL: openaiBase,
                apiKey: token,
                models: ["claude-3-5-sonnet-20241022", "gpt-4o"],
              },
            ],
          },
          null,
          2,
        ),
      ].join("\n");
    case "ama":
      // AMA（Anywhere Model Access）—— 兼容 OpenAI 接口
      return [
        "# AMA — Settings → Custom Provider → OpenAI",
        `Endpoint:  ${openaiBase}`,
        `Key:       ${token}`,
        "Model:     claude-3-5-sonnet-20241022 / gpt-4o",
        "",
        "# Anthropic 风格也可（更适合 Claude）：",
        `Endpoint:  ${anthropicBase}`,
        `Key:       ${token}`,
      ].join("\n");
    case "raw-json":
      return JSON.stringify(
        {
          openai: {
            baseURL: `${openaiBase}/chat/completions`,
            apiKey: token,
          },
          anthropic: {
            baseURL: `${anthropicBase}/messages`,
            apiKey: token,
          },
          models: ["claude-3-5-sonnet-20241022", "gpt-4o", "gpt-4o-mini"],
        },
        null,
        2,
      );
  }
}

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, MessagesSquare, Send, Sparkles } from "lucide-react";
// notify 暂未在 Playground 用——错误用红条 inline 显示；保留 import 注释以备后续 toast
// import { notify } from "@/services/notify";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { TextField } from "@/components/ui/TextField";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { apiGet } from "@/services/apiClient";
import { useModeStore } from "@/store/useModeStore";
import { useAuthStore } from "@/store/useAuthStore";

interface Model {
  id: number;
  name: string;
  displayName: string | null;
  enabled: number;
}

interface TokenRow {
  id: number;
  name: string;
  keyPreview: string;
  revoked: number;
}

interface RunResult {
  ok: boolean;
  content: string;
  httpStatus: number | null;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  raw: unknown;
  error?: string;
}

const DEFAULT_PROMPT = "用一句话介绍你自己。";

export function Playground() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 12 });
  const serverUrl = useModeStore((s) => s.serverUrl);
  const jwt = useAuthStore((s) => s.session?.tokens.accessToken);
  const base = (serverUrl ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
  const apiBase = `${base}/api/v1`;

  const [models, setModels] = useState<Model[]>([]);
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [authMethod, setAuthMethod] = useState<"jwt" | "token">("jwt");
  const [selectedToken, setSelectedToken] = useState("");
  const [model, setModel] = useState("");
  const [system, setSystem] = useState("");
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [temperature, setTemperature] = useState("0.7");
  const [maxTokens, setMaxTokens] = useState("512");
  const [stream, setStream] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [liveText, setLiveText] = useState("");

  const loadMeta = useCallback(async () => {
    try {
      const [m, tk] = await Promise.all([
        // /api/v1/models 是 OpenAI 兼容入口，列出可用模型
        fetch(`${apiBase}/models`, {
          headers: {
            ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
            "x-ccapi-internal": "1",
          },
        })
          .then((r) => (r.ok ? r.json() : { data: [] }))
          .catch(() => ({ data: [] })),
        apiGet<{ tokens: TokenRow[] }>("/api/me/tokens").catch(() => ({
          tokens: [] as TokenRow[],
        })),
      ]);
      const list: Model[] = ((m as { data?: { id: string }[] }).data ?? []).map(
        (x, i) => ({ id: i, name: x.id, displayName: null, enabled: 1 }),
      );
      setModels(list);
      setTokens(tk.tokens.filter((x) => !x.revoked));
      // 当前选中的模型不在新列表里 → 切到列表第一个；空时清空
      setModel((cur) => {
        if (list.find((m) => m.name === cur)) return cur;
        return list[0]?.name ?? "";
      });
    } catch {
      /* ignore */
    }
  }, [apiBase, jwt]);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  const modelOptions = useMemo(
    () => models.map((m) => ({ value: m.name, label: m.name })),
    [models],
  );

  const tokenOptions = useMemo(
    () =>
      [
        { value: "", label: t("playground.noToken") },
        ...tokens.map((x) => ({
          value: `${x.id}`,
          label: `${x.name} · ${x.keyPreview}`,
        })),
      ],
    [tokens, t],
  );

  const authHeader = (): Record<string, string> => {
    if (authMethod === "token" && selectedToken) {
      // 此入口我们手上没明文 token（创建后已经丢了）
      // 提示用户去用 JWT 或直接复制 token 到外部客户端
      return {};
    }
    return jwt ? { Authorization: `Bearer ${jwt}` } : {};
  };

  const run = async () => {
    if (!prompt.trim()) return;
    setRunning(true);
    setLiveText("");
    setResult(null);
    const started = performance.now();
    const messages: Array<{ role: string; content: string }> = [];
    if (system.trim()) messages.push({ role: "system", content: system.trim() });
    messages.push({ role: "user", content: prompt.trim() });

    const body = {
      model,
      messages,
      temperature: Number(temperature) || 0.7,
      max_tokens: Number(maxTokens) || 512,
      stream,
    };

    try {
      const resp = await fetch(`${apiBase}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeader() },
        body: JSON.stringify(body),
      });
      const elapsed = Math.round(performance.now() - started);
      if (!resp.ok) {
        const txt = await resp.text();
        setResult({
          ok: false,
          content: "",
          httpStatus: resp.status,
          latencyMs: elapsed,
          inputTokens: 0,
          outputTokens: 0,
          raw: txt,
          error: `HTTP ${resp.status}: ${txt.slice(0, 500)}`,
        });
        return;
      }
      if (stream && resp.body) {
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let acc = "";
        let inputTok = 0;
        let outputTok = 0;
        let raw: unknown = null;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const evt = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of evt.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (data === "[DONE]") continue;
              try {
                const j = JSON.parse(data);
                raw = j;
                const delta = j?.choices?.[0]?.delta?.content;
                if (typeof delta === "string") {
                  acc += delta;
                  setLiveText(acc);
                }
                if (j?.usage) {
                  inputTok = j.usage.prompt_tokens ?? inputTok;
                  outputTok = j.usage.completion_tokens ?? outputTok;
                }
              } catch {
                /* ignore parse */
              }
            }
          }
        }
        setResult({
          ok: true,
          content: acc,
          httpStatus: 200,
          latencyMs: Math.round(performance.now() - started),
          inputTokens: inputTok,
          outputTokens: outputTok,
          raw,
        });
      } else {
        const j = (await resp.json()) as {
          choices?: { message?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const content = j.choices?.[0]?.message?.content ?? "";
        setResult({
          ok: true,
          content,
          httpStatus: 200,
          latencyMs: elapsed,
          inputTokens: j.usage?.prompt_tokens ?? 0,
          outputTokens: j.usage?.completion_tokens ?? 0,
          raw: j,
        });
      }
    } catch (e: any) {
      setResult({
        ok: false,
        content: "",
        httpStatus: null,
        latencyMs: Math.round(performance.now() - started),
        inputTokens: 0,
        outputTokens: 0,
        raw: null,
        error: String(e?.message ?? e),
      });
    } finally {
      setRunning(false);
    }
  };

  const showContent = result?.content ?? liveText;

  return (
    <div ref={ref} className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <header>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <MessagesSquare className="h-5 w-5 text-primary" />
            {t("playground.title")}
          </h1>
          <p className="mt-1 text-sm text-muted">{t("playground.subtitle")}</p>
        </header>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr,320px]">
          {/* 主输入区 */}
          <section className="space-y-3">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted">
                {t("playground.system")}
              </label>
              <textarea
                value={system}
                onChange={(e) => setSystem(e.target.value)}
                placeholder={t("playground.system.ph")}
                rows={2}
                className="w-full rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 text-xs outline-none focus:border-primary/60 no-drag"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted">
                {t("playground.user")}
              </label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={t("playground.user.ph")}
                rows={5}
                className="w-full rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 text-sm outline-none focus:border-primary/60 no-drag"
                autoFocus
              />
            </div>
            <div className="flex gap-2">
              <Button
                onClick={() => void run()}
                loading={running}
                disabled={running || !prompt.trim()}
                className="flex-1"
              >
                <Send className="h-3.5 w-3.5" />
                {t("playground.run")}
              </Button>
            </div>

            {/* 输出区 */}
            <div className="rounded-2xl border border-border bg-surface/60 p-4 backdrop-blur-xl">
              <div className="mb-2 flex items-center justify-between text-xs text-muted">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-3.5 w-3.5 text-primary" />
                  <span>{t("playground.output")}</span>
                  {running && <Loader2 className="h-3 w-3 animate-spin" />}
                </div>
                {result && (
                  <div className="flex items-center gap-3 font-mono text-[11px]">
                    <span>{result.latencyMs} ms</span>
                    <span>↑ {result.inputTokens}</span>
                    <span>↓ {result.outputTokens}</span>
                    {result.httpStatus && (
                      <span className={result.ok ? "text-success" : "text-danger"}>
                        HTTP {result.httpStatus}
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div className="min-h-32 whitespace-pre-wrap text-sm leading-relaxed">
                {result?.error ? (
                  <div className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                    {result.error}
                  </div>
                ) : showContent ? (
                  showContent
                ) : (
                  <span className="text-xs text-muted">
                    {t("playground.outputEmpty")}
                  </span>
                )}
              </div>
            </div>
          </section>

          {/* 参数面板 */}
          <aside className="space-y-3">
            <div className="space-y-2 rounded-2xl border border-border bg-surface/60 p-4 backdrop-blur-xl">
              <p className="text-xs font-semibold">{t("playground.params")}</p>
              <div>
                <label className="mb-1 block text-[11px] text-muted">
                  {t("playground.model")}
                </label>
                <Select value={model} onValueChange={setModel} options={modelOptions} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <TextField
                  label={t("playground.temperature")}
                  type="number"
                  value={temperature}
                  onChange={(e) => setTemperature(e.target.value)}
                />
                <TextField
                  label={t("playground.maxTokens")}
                  type="number"
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(e.target.value)}
                />
              </div>
              <label className="flex items-center gap-2 pt-1 text-xs text-muted">
                <Switch checked={stream} onChange={setStream} />
                {t("playground.stream")}
              </label>
            </div>
            <div className="space-y-2 rounded-2xl border border-border bg-surface/60 p-4 backdrop-blur-xl">
              <p className="text-xs font-semibold">{t("playground.auth")}</p>
              <div>
                <label className="mb-1 block text-[11px] text-muted">
                  {t("playground.authMethod")}
                </label>
                <Select
                  value={authMethod}
                  onValueChange={(v) => setAuthMethod(v as "jwt" | "token")}
                  options={[
                    { value: "jwt", label: t("playground.auth.jwt") },
                    { value: "token", label: t("playground.auth.token") },
                  ]}
                />
              </div>
              {authMethod === "token" && (
                <>
                  <Select
                    value={selectedToken}
                    onValueChange={setSelectedToken}
                    options={tokenOptions}
                  />
                  <p className="text-[10px] leading-relaxed text-warning">
                    {t("playground.tokenNote")}
                  </p>
                </>
              )}
              <p className="text-[10px] leading-relaxed text-muted">
                {t("playground.endpoint")}: <code className="font-mono">{apiBase}</code>
              </p>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

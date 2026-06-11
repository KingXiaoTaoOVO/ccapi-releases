import { useEffect, useMemo, useState } from "react";
import { Bot, MessageSquare, Play } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Select, type SelectOption } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { TextArea, TextField } from "@/components/ui/TextField";
import { WorkspacePage } from "@/components/workspace/WorkspacePage";
import { EmptyState } from "@/components/workspace/EmptyState";
import { EntityCard } from "@/components/workspace/EntityCard";
import { useT } from "@/i18n";
import type { Agent, AgentSandbox, AgentApproval } from "@/types";
import type { MessageKey } from "@/i18n/messages";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import { useAppStore } from "@/store/useAppStore";
import { useAuthStore } from "@/store/useAuthStore";
import { useModeStore } from "@/store/useModeStore";
import { toast } from "@/store/useToastStore";
import { getAvailableModels } from "@/services/models";
import { cn } from "@/lib/cn";

const SANDBOX_LABEL: Record<AgentSandbox, MessageKey> = {
  readOnly: "agent.sandbox.readOnly",
  workspaceWrite: "agent.sandbox.workspaceWrite",
  fullAccess: "agent.sandbox.fullAccess",
};

const APPROVAL_LABEL: Record<AgentApproval, MessageKey> = {
  askEveryTime: "agent.approval.askEveryTime",
  onDemand: "agent.approval.onDemand",
  neverAsk: "agent.approval.neverAsk",
};

interface DraftState {
  name: string;
  role: string;
  description: string;
  systemPrompt: string;
  model: string;
  sandbox: AgentSandbox;
  approval: AgentApproval;
  networkAccess: boolean;
  skillIds: string[];
  mcpIds: string[];
  ruleIds: string[];
}

const EMPTY_DRAFT: DraftState = {
  name: "",
  role: "",
  description: "",
  systemPrompt: "",
  model: "",
  sandbox: "workspaceWrite",
  approval: "onDemand",
  networkAccess: false,
  skillIds: [],
  mcpIds: [],
  ruleIds: [],
};

function toggleId(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

interface PickerOption {
  id: string;
  name: string;
  enabled: boolean;
  hint?: string;
}

function CheckboxList({
  label,
  hint,
  options,
  selected,
  onToggle,
}: {
  label: string;
  hint?: string;
  options: PickerOption[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  const t = useT();
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted">{label}</p>
      {options.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border bg-surface-2/40 px-3 py-3 text-xs text-muted/80">
          {t("agent.noneAvailable")}
        </p>
      ) : (
        <div className="max-h-44 overflow-y-auto rounded-xl border border-border bg-surface-2/50 p-1.5">
          {options.map((opt) => {
            const active = selected.includes(opt.id);
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => onToggle(opt.id)}
                className={cn(
                  "no-drag flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors",
                  active ? "bg-primary/15 text-primary" : "text-text hover:bg-surface-2",
                )}
              >
                <span
                  className={cn(
                    "grid h-4 w-4 shrink-0 place-items-center rounded border",
                    active
                      ? "border-primary bg-primary text-white"
                      : "border-border bg-surface",
                  )}
                >
                  {active && (
                    <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none">
                      <path
                        d="M3 8.5l3 3 7-7"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </span>
                <span className="flex-1 truncate">{opt.name}</span>
                {!opt.enabled && (
                  <span className="text-[10px] uppercase text-muted">
                    {t("ws.disabled")}
                  </span>
                )}
                {opt.hint && (
                  <span className="text-[11px] text-muted">{opt.hint}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {hint && <p className="text-[11px] text-muted/70">{hint}</p>}
    </div>
  );
}

export function Agents() {
  const t = useT();
  const agents = useWorkspaceStore((s) => s.agents);
  const skills = useWorkspaceStore((s) => s.skills);
  const mcpServers = useWorkspaceStore((s) => s.mcpServers);
  const rules = useWorkspaceStore((s) => s.rules);
  const add = useWorkspaceStore((s) => s.addAgent);
  const update = useWorkspaceStore((s) => s.updateAgent);
  const remove = useWorkspaceStore((s) => s.removeAgent);
  const toggle = useWorkspaceStore((s) => s.toggleAgent);
  const enqueueTask = useWorkspaceStore((s) => s.enqueueTask);
  const createChat = useWorkspaceStore((s) => s.createChat);
  const setView = useAppStore((s) => s.setView);
  const proxySource = useAppStore((s) => s.settings.proxySource ?? "local");
  const keys = useAppStore((s) => s.keys);
  const activeKeyId = useAppStore((s) => s.activeKeyId);
  const serverUrl = useModeStore((s) => s.serverUrl);
  const jwt = useAuthStore((s) => s.session?.tokens.accessToken);

  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Agent | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [modelOptions, setModelOptions] = useState<SelectOption[]>([]);
  const [modelFlat, setModelFlat] = useState<string[]>([]);

  /** 稳定指纹 —— 监控扫描更新 status 不会触发重探。 */
  const keysFingerprint = useMemo(() => {
    if (proxySource === "official") return "";
    return keys
      .filter((k) => k.enabled && !!k.key)
      .map((k) =>
        [k.id, k.key, k.url ?? "", k.authField ?? ""].join(""),
      )
      .join("");
  }, [keys, proxySource]);

  // 动态拉「当前代理实际能用的模型列表」——
  // 所有 key 的模型合并去重（相同模型只显示一次），按出现顺序（active key 优先）排列
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await getAvailableModels(
        proxySource === "official"
          ? { source: "official", serverUrl, jwt: jwt ?? null }
          : { source: "local", keys, activeKeyId },
      );
      if (cancelled) return;
      setModelOptions(res.flat.map((m) => ({ value: m, label: m })));
      setModelFlat(res.flat);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proxySource, serverUrl, jwt, keysFingerprint, activeKeyId]);

  const sandboxOptions = (
    Object.keys(SANDBOX_LABEL) as AgentSandbox[]
  ).map((k) => ({ value: k, label: t(SANDBOX_LABEL[k]) }));
  const approvalOptions = (
    Object.keys(APPROVAL_LABEL) as AgentApproval[]
  ).map((k) => ({ value: k, label: t(APPROVAL_LABEL[k]) }));

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter((a) =>
      [a.name, a.role, a.description ?? "", a.systemPrompt].some((s) =>
        s.toLowerCase().includes(q),
      ),
    );
  }, [agents, query]);

  const openCreate = () => {
    setEditing(null);
    setDraft({ ...EMPTY_DRAFT, model: modelFlat[0] ?? "" });
    setOpen(true);
  };

  const openEdit = (a: Agent) => {
    setEditing(a);
    setDraft({
      name: a.name,
      role: a.role,
      description: a.description ?? "",
      systemPrompt: a.systemPrompt,
      model: a.model,
      sandbox: a.sandbox,
      approval: a.approval,
      networkAccess: a.networkAccess,
      skillIds: [...a.skillIds],
      mcpIds: [...a.mcpIds],
      ruleIds: [...a.ruleIds],
    });
    setOpen(true);
  };

  const submit = () => {
    if (!draft.name.trim() || !draft.systemPrompt.trim()) {
      toast.error(t("ws.required"));
      return;
    }
    const payload = {
      name: draft.name.trim(),
      role: draft.role.trim(),
      description: draft.description.trim() || undefined,
      systemPrompt: draft.systemPrompt,
      model: draft.model,
      sandbox: draft.sandbox,
      approval: draft.approval,
      networkAccess: draft.networkAccess,
      skillIds: draft.skillIds,
      mcpIds: draft.mcpIds,
      ruleIds: draft.ruleIds,
    };
    if (editing) {
      update(editing.id, payload);
      toast.success(t("ws.updated"));
    } else {
      add(payload);
      toast.success(t("ws.created"));
    }
    setOpen(false);
  };

  const dispatchTask = (a: Agent) => {
    enqueueTask({
      agentId: a.id,
      kind: "ask",
      prompt: a.systemPrompt.slice(0, 200) || a.name,
    });
    toast.success(t("ws.created"));
    setView("tasks");
  };

  const dispatchChat = (a: Agent) => {
    createChat("ask", a.id, a.name);
    setView("chat");
  };

  return (
    <>
      <WorkspacePage
        search={{ value: query, onChange: setQuery }}
        primaryAction={{ label: t("agent.add"), onClick: openCreate }}
      >
        {filtered.length === 0 ? (
          <EmptyState
            icon={Bot}
            title={agents.length === 0 ? t("ws.empty") : t("dash.noMatch")}
            hint={agents.length === 0 ? t("ws.emptyHint") : undefined}
            action={
              agents.length === 0 && (
                <Button onClick={openCreate}>{t("agent.add")}</Button>
              )
            }
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map((a) => (
              <EntityCard
                key={a.id}
                title={a.name}
                subtitle={a.role}
                enabled={a.enabled}
                onToggle={() => toggle(a.id)}
                onEdit={() => openEdit(a)}
                onDelete={() => remove(a.id)}
                updatedAt={a.updatedAt}
                badges={
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
                    {t(SANDBOX_LABEL[a.sandbox])}
                  </span>
                }
                extraActions={
                  <>
                    <button
                      onClick={() => dispatchChat(a)}
                      className="no-drag rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-primary"
                      title={t("agent.startChat")}
                      aria-label={t("agent.startChat")}
                    >
                      <MessageSquare className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => dispatchTask(a)}
                      className="no-drag rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-primary"
                      title={t("agent.runTask")}
                      aria-label={t("agent.runTask")}
                    >
                      <Play className="h-4 w-4" />
                    </button>
                  </>
                }
              >
                {a.description && (
                  <p className="line-clamp-2 text-xs text-muted">{a.description}</p>
                )}
                <p className="mt-1 text-[11px] text-muted/80">
                  {a.model} · {t(APPROVAL_LABEL[a.approval])}
                  {a.networkAccess && ` · ${t("agent.network")}`}
                </p>
              </EntityCard>
            ))}
          </div>
        )}
      </WorkspacePage>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? t("agent.edit") : t("agent.add")}
        size="xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t("ws.cancel")}
            </Button>
            <Button onClick={submit}>{t("ws.save")}</Button>
          </>
        }
      >
        <div className="grid gap-4 md:grid-cols-2">
          <TextField
            label={t("agent.name")}
            placeholder={t("agent.namePlaceholder")}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            required
          />
          <TextField
            label={t("agent.role")}
            placeholder={t("agent.rolePlaceholder")}
            value={draft.role}
            onChange={(e) => setDraft({ ...draft, role: e.target.value })}
          />
          <div className="md:col-span-2">
            <TextField
              label={t("agent.description")}
              placeholder={t("agent.descriptionPlaceholder")}
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </div>
          <div className="md:col-span-2">
            <TextArea
              label={t("agent.systemPrompt")}
              placeholder={t("agent.systemPromptPlaceholder")}
              value={draft.systemPrompt}
              onChange={(e) =>
                setDraft({ ...draft, systemPrompt: e.target.value })
              }
              rows={6}
              required
            />
          </div>
          <Select
            label={t("agent.model")}
            value={draft.model}
            onValueChange={(v) => setDraft({ ...draft, model: v })}
            options={modelOptions}
            placeholder="无可用模型"
          />
          <Select
            label={t("agent.sandbox")}
            value={draft.sandbox}
            onValueChange={(v) =>
              setDraft({ ...draft, sandbox: v as AgentSandbox })
            }
            options={sandboxOptions}
          />
          <Select
            label={t("agent.approval")}
            value={draft.approval}
            onValueChange={(v) =>
              setDraft({ ...draft, approval: v as AgentApproval })
            }
            options={approvalOptions}
          />
          <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-2/60 px-3.5 py-2.5">
            <Switch
              checked={draft.networkAccess}
              onChange={(v) => setDraft({ ...draft, networkAccess: v })}
              label={t("agent.network")}
            />
            <span className="text-sm">{t("agent.network")}</span>
          </div>
          <div className="md:col-span-2">
            <CheckboxList
              label={t("agent.skills")}
              hint={t("agent.skillsHint")}
              options={skills.map((s) => ({
                id: s.id,
                name: s.name,
                enabled: s.enabled,
              }))}
              selected={draft.skillIds}
              onToggle={(id) =>
                setDraft({ ...draft, skillIds: toggleId(draft.skillIds, id) })
              }
            />
          </div>
          <div>
            <CheckboxList
              label={t("agent.mcp")}
              hint={t("agent.mcpHint")}
              options={mcpServers.map((s) => ({
                id: s.id,
                name: s.name,
                enabled: s.enabled,
                hint: s.transport,
              }))}
              selected={draft.mcpIds}
              onToggle={(id) =>
                setDraft({ ...draft, mcpIds: toggleId(draft.mcpIds, id) })
              }
            />
          </div>
          <div>
            <CheckboxList
              label={t("agent.rules")}
              hint={t("agent.rulesHint")}
              options={rules.map((r) => ({
                id: r.id,
                name: r.name,
                enabled: r.enabled,
              }))}
              selected={draft.ruleIds}
              onToggle={(id) =>
                setDraft({ ...draft, ruleIds: toggleId(draft.ruleIds, id) })
              }
            />
          </div>
        </div>
      </Modal>
    </>
  );
}

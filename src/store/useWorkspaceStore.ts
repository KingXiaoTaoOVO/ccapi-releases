import { create } from "zustand";
import type {
  Agent,
  AgentSandbox,
  AgentApproval,
  AgentTask,
  AgentTaskKind,
  AgentTaskStatus,
  ChatMessage,
  ChatMode,
  ChatSession,
  LogEntry,
  LogLevel,
  McpServer,
  McpTransport,
  Rule,
  RuleScope,
  Skill,
} from "@/types";
import { uid } from "@/lib/format";

/**
 * Workspace store — owns user-defined skills, MCP servers, rules, agents,
 * task history and chat sessions. Persistence is driven by `useAppStore`:
 * every mutation here calls `notifyPersist()`, which the app store wires up
 * during init so all entities serialize into the same on-disk state blob.
 */

let persistNotifier: (() => void) | null = null;

/** Called by useAppStore after init() to attach the persistence hook. */
export function bindWorkspacePersist(notify: () => void) {
  persistNotifier = notify;
}

function notifyPersist() {
  if (persistNotifier) persistNotifier();
}

function nowIso(): string {
  return new Date().toISOString();
}

export interface SkillDraft {
  name: string;
  description?: string;
  body: string;
  tags: string[];
  enabled?: boolean;
}

export interface McpServerDraft {
  name: string;
  description?: string;
  transport: McpTransport;
  endpoint: string;
  args: string[];
  env: Record<string, string>;
  enabled?: boolean;
}

export interface RuleDraft {
  name: string;
  scope: RuleScope;
  body: string;
  enabled?: boolean;
}

export interface AgentDraft {
  name: string;
  role: string;
  description?: string;
  systemPrompt: string;
  model: string;
  sandbox: AgentSandbox;
  approval: AgentApproval;
  networkAccess: boolean;
  skillIds: string[];
  mcpIds: string[];
  ruleIds: string[];
  enabled?: boolean;
}

export interface AgentTaskDraft {
  agentId: string | null;
  kind: AgentTaskKind;
  prompt: string;
}

interface WorkspaceState {
  skills: Skill[];
  mcpServers: McpServer[];
  rules: Rule[];
  agents: Agent[];
  tasks: AgentTask[];
  chats: ChatSession[];
  logs: LogEntry[];

  /** Hydrate from persisted snapshot (called once during app init). */
  hydrate: (input: {
    skills: Skill[];
    mcpServers: McpServer[];
    rules: Rule[];
    agents: Agent[];
    tasks: AgentTask[];
    chats: ChatSession[];
    logs: LogEntry[];
  }) => void;

  // Skills
  addSkill: (draft: SkillDraft) => Skill;
  updateSkill: (id: string, patch: Partial<SkillDraft>) => void;
  removeSkill: (id: string) => void;
  toggleSkill: (id: string) => void;

  // MCP servers
  addMcpServer: (draft: McpServerDraft) => McpServer;
  updateMcpServer: (id: string, patch: Partial<McpServerDraft>) => void;
  removeMcpServer: (id: string) => void;
  toggleMcpServer: (id: string) => void;

  // Rules
  addRule: (draft: RuleDraft) => Rule;
  updateRule: (id: string, patch: Partial<RuleDraft>) => void;
  removeRule: (id: string) => void;
  toggleRule: (id: string) => void;

  // Agents
  addAgent: (draft: AgentDraft) => Agent;
  updateAgent: (id: string, patch: Partial<AgentDraft>) => void;
  removeAgent: (id: string) => void;
  toggleAgent: (id: string) => void;

  // Tasks
  enqueueTask: (draft: AgentTaskDraft) => AgentTask;
  updateTaskStatus: (id: string, status: AgentTaskStatus, summary?: string) => void;
  clearFinishedTasks: () => void;
  removeTask: (id: string) => void;

  // Chats
  createChat: (mode: ChatMode, agentId?: string | null, title?: string) => ChatSession;
  renameChat: (id: string, title: string) => void;
  removeChat: (id: string) => void;
  appendMessage: (chatId: string, message: Omit<ChatMessage, "id" | "createdAt">) => ChatMessage;
  clearChat: (chatId: string) => void;

  // Logs
  log: (
    level: LogLevel,
    source: string,
    message: string,
    detail?: string,
  ) => LogEntry;
  removeLog: (id: string) => void;
  clearLogs: (level?: LogLevel) => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  skills: [],
  mcpServers: [],
  rules: [],
  agents: [],
  tasks: [],
  chats: [],
  logs: [],

  hydrate: (input) => set(input),

  addSkill: (draft) => {
    const now = nowIso();
    const skill: Skill = {
      id: uid("skill"),
      name: draft.name,
      description: draft.description,
      body: draft.body,
      tags: draft.tags,
      enabled: draft.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    set((s) => ({ skills: [...s.skills, skill] }));
    notifyPersist();
    return skill;
  },

  updateSkill: (id, patch) => {
    set((s) => ({
      skills: s.skills.map((sk) =>
        sk.id === id ? { ...sk, ...patch, updatedAt: nowIso() } : sk,
      ),
    }));
    notifyPersist();
  },

  removeSkill: (id) => {
    set((s) => ({
      skills: s.skills.filter((sk) => sk.id !== id),
      agents: s.agents.map((a) => ({
        ...a,
        skillIds: a.skillIds.filter((x) => x !== id),
      })),
    }));
    notifyPersist();
  },

  toggleSkill: (id) => {
    set((s) => ({
      skills: s.skills.map((sk) =>
        sk.id === id ? { ...sk, enabled: !sk.enabled, updatedAt: nowIso() } : sk,
      ),
    }));
    notifyPersist();
  },

  addMcpServer: (draft) => {
    const now = nowIso();
    const server: McpServer = {
      id: uid("mcp"),
      name: draft.name,
      description: draft.description,
      transport: draft.transport,
      endpoint: draft.endpoint,
      args: draft.args,
      env: draft.env,
      enabled: draft.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    set((s) => ({ mcpServers: [...s.mcpServers, server] }));
    notifyPersist();
    return server;
  },

  updateMcpServer: (id, patch) => {
    set((s) => ({
      mcpServers: s.mcpServers.map((m) =>
        m.id === id ? { ...m, ...patch, updatedAt: nowIso() } : m,
      ),
    }));
    notifyPersist();
  },

  removeMcpServer: (id) => {
    set((s) => ({
      mcpServers: s.mcpServers.filter((m) => m.id !== id),
      agents: s.agents.map((a) => ({
        ...a,
        mcpIds: a.mcpIds.filter((x) => x !== id),
      })),
    }));
    notifyPersist();
  },

  toggleMcpServer: (id) => {
    set((s) => ({
      mcpServers: s.mcpServers.map((m) =>
        m.id === id ? { ...m, enabled: !m.enabled, updatedAt: nowIso() } : m,
      ),
    }));
    notifyPersist();
  },

  addRule: (draft) => {
    const now = nowIso();
    const rule: Rule = {
      id: uid("rule"),
      name: draft.name,
      scope: draft.scope,
      body: draft.body,
      enabled: draft.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    set((s) => ({ rules: [...s.rules, rule] }));
    notifyPersist();
    return rule;
  },

  updateRule: (id, patch) => {
    set((s) => ({
      rules: s.rules.map((r) =>
        r.id === id ? { ...r, ...patch, updatedAt: nowIso() } : r,
      ),
    }));
    notifyPersist();
  },

  removeRule: (id) => {
    set((s) => ({
      rules: s.rules.filter((r) => r.id !== id),
      agents: s.agents.map((a) => ({
        ...a,
        ruleIds: a.ruleIds.filter((x) => x !== id),
      })),
    }));
    notifyPersist();
  },

  toggleRule: (id) => {
    set((s) => ({
      rules: s.rules.map((r) =>
        r.id === id ? { ...r, enabled: !r.enabled, updatedAt: nowIso() } : r,
      ),
    }));
    notifyPersist();
  },

  addAgent: (draft) => {
    const now = nowIso();
    const agent: Agent = {
      id: uid("agent"),
      name: draft.name,
      role: draft.role,
      description: draft.description,
      systemPrompt: draft.systemPrompt,
      model: draft.model,
      sandbox: draft.sandbox,
      approval: draft.approval,
      networkAccess: draft.networkAccess,
      skillIds: draft.skillIds,
      mcpIds: draft.mcpIds,
      ruleIds: draft.ruleIds,
      enabled: draft.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    set((s) => ({ agents: [...s.agents, agent] }));
    notifyPersist();
    return agent;
  },

  updateAgent: (id, patch) => {
    set((s) => ({
      agents: s.agents.map((a) =>
        a.id === id ? { ...a, ...patch, updatedAt: nowIso() } : a,
      ),
    }));
    notifyPersist();
  },

  removeAgent: (id) => {
    set((s) => ({
      agents: s.agents.filter((a) => a.id !== id),
      tasks: s.tasks.map((t) =>
        t.agentId === id ? { ...t, agentId: null } : t,
      ),
      chats: s.chats.map((c) =>
        c.agentId === id ? { ...c, agentId: null } : c,
      ),
    }));
    notifyPersist();
  },

  toggleAgent: (id) => {
    set((s) => ({
      agents: s.agents.map((a) =>
        a.id === id ? { ...a, enabled: !a.enabled, updatedAt: nowIso() } : a,
      ),
    }));
    notifyPersist();
  },

  enqueueTask: (draft) => {
    const task: AgentTask = {
      id: uid("task"),
      agentId: draft.agentId,
      kind: draft.kind,
      prompt: draft.prompt,
      status: "queued",
      createdAt: nowIso(),
    };
    set((s) => ({ tasks: [task, ...s.tasks] }));
    notifyPersist();
    return task;
  },

  updateTaskStatus: (id, status, summary) => {
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === id
          ? {
              ...t,
              status,
              summary: summary ?? t.summary,
              finishedAt:
                status === "succeeded" || status === "failed" || status === "canceled"
                  ? nowIso()
                  : t.finishedAt,
            }
          : t,
      ),
    }));
    notifyPersist();
  },

  clearFinishedTasks: () => {
    set((s) => ({
      tasks: s.tasks.filter(
        (t) => t.status === "queued" || t.status === "running",
      ),
    }));
    notifyPersist();
  },

  removeTask: (id) => {
    set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
    notifyPersist();
  },

  createChat: (mode, agentId, title) => {
    const now = nowIso();
    const chat: ChatSession = {
      id: uid("chat"),
      title: title ?? "",
      mode,
      agentId: agentId ?? null,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    set((s) => ({ chats: [chat, ...s.chats] }));
    notifyPersist();
    return chat;
  },

  renameChat: (id, title) => {
    set((s) => ({
      chats: s.chats.map((c) =>
        c.id === id ? { ...c, title, updatedAt: nowIso() } : c,
      ),
    }));
    notifyPersist();
  },

  removeChat: (id) => {
    set((s) => ({ chats: s.chats.filter((c) => c.id !== id) }));
    notifyPersist();
  },

  appendMessage: (chatId, message) => {
    const msg: ChatMessage = {
      id: uid("msg"),
      role: message.role,
      content: message.content,
      attachments: message.attachments,
      createdAt: nowIso(),
    };
    set((s) => ({
      chats: s.chats.map((c) =>
        c.id === chatId
          ? { ...c, messages: [...c.messages, msg], updatedAt: msg.createdAt }
          : c,
      ),
    }));
    notifyPersist();
    return msg;
  },

  clearChat: (chatId) => {
    set((s) => ({
      chats: s.chats.map((c) =>
        c.id === chatId ? { ...c, messages: [], updatedAt: nowIso() } : c,
      ),
    }));
    notifyPersist();
  },

  log: (level, source, message, detail) => {
    const entry: LogEntry = {
      id: uid("log"),
      level,
      source,
      message,
      detail,
      createdAt: nowIso(),
    };
    // Defensive dedupe — if a buggy double-subscription or rapid retry loop
    // emits the *same* entry twice within DEDUPE_WINDOW_MS, skip the second
    // write. Caps the log at 500 to keep the persisted blob small.
    const DEDUPE_WINDOW_MS = 1500;
    set((s) => {
      const head = s.logs[0];
      if (
        head &&
        head.level === level &&
        head.source === source &&
        head.message === message &&
        head.detail === detail &&
        Date.now() - new Date(head.createdAt).getTime() < DEDUPE_WINDOW_MS
      ) {
        return s;
      }
      return { logs: [entry, ...s.logs].slice(0, 500) };
    });
    notifyPersist();
    return entry;
  },

  removeLog: (id) => {
    set((s) => ({ logs: s.logs.filter((l) => l.id !== id) }));
    notifyPersist();
  },

  clearLogs: (level) => {
    set((s) => ({
      logs: level ? s.logs.filter((l) => l.level !== level) : [],
    }));
    notifyPersist();
  },
}));

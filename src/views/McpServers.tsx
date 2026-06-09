import { useMemo, useState } from "react";
import { Plug } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { TextArea, TextField } from "@/components/ui/TextField";
import { WorkspacePage } from "@/components/workspace/WorkspacePage";
import { EmptyState } from "@/components/workspace/EmptyState";
import { EntityCard } from "@/components/workspace/EntityCard";
import { useT } from "@/i18n";
import type { McpServer, McpTransport } from "@/types";
import type { MessageKey } from "@/i18n/messages";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import { toast } from "@/store/useToastStore";

const TRANSPORTS: { value: McpTransport; labelKey: MessageKey }[] = [
  { value: "stdio", labelKey: "mcp.transport.stdio" },
  { value: "http", labelKey: "mcp.transport.http" },
  { value: "sse", labelKey: "mcp.transport.sse" },
];

function parseLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseEnv(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of parseLines(raw)) {
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

function stringifyEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

interface DraftState {
  name: string;
  description: string;
  transport: McpTransport;
  endpoint: string;
  args: string;
  env: string;
}

const EMPTY_DRAFT: DraftState = {
  name: "",
  description: "",
  transport: "stdio",
  endpoint: "",
  args: "",
  env: "",
};

export function McpServers() {
  const t = useT();
  const servers = useWorkspaceStore((s) => s.mcpServers);
  const add = useWorkspaceStore((s) => s.addMcpServer);
  const update = useWorkspaceStore((s) => s.updateMcpServer);
  const remove = useWorkspaceStore((s) => s.removeMcpServer);
  const toggle = useWorkspaceStore((s) => s.toggleMcpServer);

  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<McpServer | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);

  const transportOptions = TRANSPORTS.map((t0) => ({
    value: t0.value,
    label: t(t0.labelKey),
  }));

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return servers;
    return servers.filter((m) =>
      [m.name, m.description ?? "", m.endpoint].some((s) =>
        s.toLowerCase().includes(q),
      ),
    );
  }, [servers, query]);

  const openCreate = () => {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setOpen(true);
  };

  const openEdit = (s: McpServer) => {
    setEditing(s);
    setDraft({
      name: s.name,
      description: s.description ?? "",
      transport: s.transport,
      endpoint: s.endpoint,
      args: s.args.join("\n"),
      env: stringifyEnv(s.env),
    });
    setOpen(true);
  };

  const submit = () => {
    if (!draft.name.trim() || !draft.endpoint.trim()) {
      toast.error(t("ws.required"));
      return;
    }
    const payload = {
      name: draft.name.trim(),
      description: draft.description.trim() || undefined,
      transport: draft.transport,
      endpoint: draft.endpoint.trim(),
      args: parseLines(draft.args),
      env: parseEnv(draft.env),
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

  return (
    <>
      <WorkspacePage
        search={{ value: query, onChange: setQuery }}
        primaryAction={{ label: t("mcp.add"), onClick: openCreate }}
      >
        {filtered.length === 0 ? (
          <EmptyState
            icon={Plug}
            title={servers.length === 0 ? t("ws.empty") : t("dash.noMatch")}
            hint={servers.length === 0 ? t("ws.emptyHint") : undefined}
            action={
              servers.length === 0 && (
                <Button onClick={openCreate}>{t("mcp.add")}</Button>
              )
            }
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map((s) => (
              <EntityCard
                key={s.id}
                title={s.name}
                subtitle={s.description}
                enabled={s.enabled}
                onToggle={() => toggle(s.id)}
                onEdit={() => openEdit(s)}
                onDelete={() => remove(s.id)}
                updatedAt={s.updatedAt}
                badges={
                  <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] uppercase text-muted">
                    {s.transport}
                  </span>
                }
              >
                <p className="truncate font-mono text-[11px] text-muted">
                  {s.endpoint}
                </p>
                {(s.args.length > 0 || Object.keys(s.env).length > 0) && (
                  <p className="mt-1 text-[11px] text-muted/70">
                    {s.args.length > 0 && `args: ${s.args.length}`}
                    {s.args.length > 0 && Object.keys(s.env).length > 0 && " · "}
                    {Object.keys(s.env).length > 0 &&
                      `env: ${Object.keys(s.env).length}`}
                  </p>
                )}
              </EntityCard>
            ))}
          </div>
        )}
      </WorkspacePage>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? t("mcp.edit") : t("mcp.add")}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t("ws.cancel")}
            </Button>
            <Button onClick={submit}>{t("ws.save")}</Button>
          </>
        }
      >
        <div className="space-y-4">
          <TextField
            label={t("mcp.name")}
            placeholder={t("mcp.namePlaceholder")}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            required
          />
          <TextField
            label={t("mcp.description")}
            placeholder={t("mcp.descriptionPlaceholder")}
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
          <Select
            label={t("mcp.transport")}
            value={draft.transport}
            onValueChange={(v) =>
              setDraft({ ...draft, transport: v as McpTransport })
            }
            options={transportOptions}
          />
          <TextField
            label={t("mcp.endpoint")}
            placeholder={
              draft.transport === "stdio"
                ? t("mcp.endpoint.stdioPlaceholder")
                : t("mcp.endpoint.urlPlaceholder")
            }
            value={draft.endpoint}
            onChange={(e) => setDraft({ ...draft, endpoint: e.target.value })}
            required
          />
          {draft.transport === "stdio" && (
            <>
              <TextArea
                label={t("mcp.args")}
                hint={t("mcp.argsHint")}
                value={draft.args}
                onChange={(e) => setDraft({ ...draft, args: e.target.value })}
                rows={3}
              />
              <TextArea
                label={t("mcp.env")}
                hint={t("mcp.envHint")}
                value={draft.env}
                onChange={(e) => setDraft({ ...draft, env: e.target.value })}
                rows={3}
              />
            </>
          )}
        </div>
      </Modal>
    </>
  );
}

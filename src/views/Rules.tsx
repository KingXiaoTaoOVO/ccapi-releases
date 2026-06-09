import { useMemo, useState } from "react";
import { ScrollText } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { TextArea, TextField } from "@/components/ui/TextField";
import { WorkspacePage } from "@/components/workspace/WorkspacePage";
import { EmptyState } from "@/components/workspace/EmptyState";
import { EntityCard } from "@/components/workspace/EntityCard";
import { useT } from "@/i18n";
import type { Rule, RuleScope } from "@/types";
import type { MessageKey } from "@/i18n/messages";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import { toast } from "@/store/useToastStore";

const SCOPES: { value: RuleScope; labelKey: MessageKey }[] = [
  { value: "global", labelKey: "rule.scope.global" },
  { value: "project", labelKey: "rule.scope.project" },
  { value: "personal", labelKey: "rule.scope.personal" },
];

const SCOPE_LABEL: Record<RuleScope, MessageKey> = {
  global: "rule.scope.global",
  project: "rule.scope.project",
  personal: "rule.scope.personal",
};

interface DraftState {
  name: string;
  scope: RuleScope;
  body: string;
}

const EMPTY_DRAFT: DraftState = {
  name: "",
  scope: "project",
  body: "",
};

export function Rules() {
  const t = useT();
  const rules = useWorkspaceStore((s) => s.rules);
  const add = useWorkspaceStore((s) => s.addRule);
  const update = useWorkspaceStore((s) => s.updateRule);
  const remove = useWorkspaceStore((s) => s.removeRule);
  const toggle = useWorkspaceStore((s) => s.toggleRule);

  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Rule | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);

  const scopeOptions = SCOPES.map((sc) => ({
    value: sc.value,
    label: t(sc.labelKey),
  }));

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rules;
    return rules.filter((r) =>
      [r.name, r.body].some((s) => s.toLowerCase().includes(q)),
    );
  }, [rules, query]);

  const openCreate = () => {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setOpen(true);
  };

  const openEdit = (r: Rule) => {
    setEditing(r);
    setDraft({ name: r.name, scope: r.scope, body: r.body });
    setOpen(true);
  };

  const submit = () => {
    if (!draft.name.trim() || !draft.body.trim()) {
      toast.error(t("ws.required"));
      return;
    }
    const payload = {
      name: draft.name.trim(),
      scope: draft.scope,
      body: draft.body,
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
        primaryAction={{ label: t("rule.add"), onClick: openCreate }}
      >
        {filtered.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title={rules.length === 0 ? t("ws.empty") : t("dash.noMatch")}
            hint={rules.length === 0 ? t("ws.emptyHint") : undefined}
            action={
              rules.length === 0 && (
                <Button onClick={openCreate}>{t("rule.add")}</Button>
              )
            }
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map((r) => (
              <EntityCard
                key={r.id}
                title={r.name}
                enabled={r.enabled}
                onToggle={() => toggle(r.id)}
                onEdit={() => openEdit(r)}
                onDelete={() => remove(r.id)}
                updatedAt={r.updatedAt}
                badges={
                  <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted">
                    {t(SCOPE_LABEL[r.scope])}
                  </span>
                }
              >
                <p className="line-clamp-4 whitespace-pre-wrap text-xs text-muted">
                  {r.body}
                </p>
              </EntityCard>
            ))}
          </div>
        )}
      </WorkspacePage>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? t("rule.edit") : t("rule.add")}
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
            label={t("rule.name")}
            placeholder={t("rule.namePlaceholder")}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            required
          />
          <Select
            label={t("rule.scope")}
            value={draft.scope}
            onValueChange={(v) => setDraft({ ...draft, scope: v as RuleScope })}
            options={scopeOptions}
          />
          <TextArea
            label={t("rule.body")}
            placeholder={t("rule.bodyPlaceholder")}
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            rows={8}
            required
          />
        </div>
      </Modal>
    </>
  );
}

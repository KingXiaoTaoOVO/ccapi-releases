import { useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { TextArea, TextField } from "@/components/ui/TextField";
import { WorkspacePage } from "@/components/workspace/WorkspacePage";
import { EmptyState } from "@/components/workspace/EmptyState";
import { EntityCard } from "@/components/workspace/EntityCard";
import { useT } from "@/i18n";
import type { Skill } from "@/types";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import { toast } from "@/store/useToastStore";

/** Parse a space/comma-separated tag string into a normalized, deduped list. */
function parseTags(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tok of raw.split(/[\s,，、]+/)) {
    const v = tok.trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

interface DraftState {
  name: string;
  description: string;
  body: string;
  tags: string;
}

const EMPTY_DRAFT: DraftState = {
  name: "",
  description: "",
  body: "",
  tags: "",
};

export function Skills() {
  const t = useT();
  const skills = useWorkspaceStore((s) => s.skills);
  const agents = useWorkspaceStore((s) => s.agents);
  const addSkill = useWorkspaceStore((s) => s.addSkill);
  const updateSkill = useWorkspaceStore((s) => s.updateSkill);
  const removeSkill = useWorkspaceStore((s) => s.removeSkill);
  const toggleSkill = useWorkspaceStore((s) => s.toggleSkill);

  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Skill | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter((sk) => {
      return (
        sk.name.toLowerCase().includes(q) ||
        sk.description?.toLowerCase().includes(q) ||
        sk.tags.some((tg) => tg.toLowerCase().includes(q))
      );
    });
  }, [skills, query]);

  const openCreate = () => {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setOpen(true);
  };

  const openEdit = (sk: Skill) => {
    setEditing(sk);
    setDraft({
      name: sk.name,
      description: sk.description ?? "",
      body: sk.body,
      tags: sk.tags.join(" "),
    });
    setOpen(true);
  };

  const submit = () => {
    if (!draft.name.trim() || !draft.body.trim()) {
      toast.error(t("ws.required"));
      return;
    }
    const payload = {
      name: draft.name.trim(),
      description: draft.description.trim() || undefined,
      body: draft.body,
      tags: parseTags(draft.tags),
    };
    if (editing) {
      updateSkill(editing.id, payload);
      toast.success(t("ws.updated"));
    } else {
      addSkill(payload);
      toast.success(t("ws.created"));
    }
    setOpen(false);
  };

  return (
    <>
      <WorkspacePage
        search={{ value: query, onChange: setQuery }}
        primaryAction={{ label: t("skill.add"), onClick: openCreate }}
      >
        {filtered.length === 0 ? (
          <EmptyState
            icon={Sparkles}
            title={skills.length === 0 ? t("ws.empty") : t("dash.noMatch")}
            hint={skills.length === 0 ? t("ws.emptyHint") : undefined}
            action={
              skills.length === 0 && (
                <Button onClick={openCreate}>{t("skill.add")}</Button>
              )
            }
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map((sk) => {
              const usedBy = agents.filter((a) => a.skillIds.includes(sk.id)).length;
              return (
                <EntityCard
                  key={sk.id}
                  title={sk.name}
                  subtitle={sk.description}
                  enabled={sk.enabled}
                  onToggle={() => toggleSkill(sk.id)}
                  onEdit={() => openEdit(sk)}
                  onDelete={() => removeSkill(sk.id)}
                  updatedAt={sk.updatedAt}
                  badges={
                    usedBy > 0 ? (
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
                        {t("skill.usedBy", { n: usedBy })}
                      </span>
                    ) : null
                  }
                >
                  <p className="line-clamp-3 whitespace-pre-wrap text-xs text-muted">
                    {sk.body}
                  </p>
                  {sk.tags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {sk.tags.map((tg) => (
                        <span
                          key={tg}
                          className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted"
                        >
                          #{tg}
                        </span>
                      ))}
                    </div>
                  )}
                </EntityCard>
              );
            })}
          </div>
        )}
      </WorkspacePage>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? t("skill.edit") : t("skill.add")}
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
            label={t("skill.name")}
            placeholder={t("skill.namePlaceholder")}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            required
          />
          <TextField
            label={t("skill.description")}
            placeholder={t("skill.descriptionPlaceholder")}
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
          <TextArea
            label={t("skill.body")}
            placeholder={t("skill.bodyPlaceholder")}
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            rows={8}
            required
          />
          <TextField
            label={t("skill.tags")}
            hint={t("skill.tagsHint")}
            value={draft.tags}
            onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
          />
        </div>
      </Modal>
    </>
  );
}

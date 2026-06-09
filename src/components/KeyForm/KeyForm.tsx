import { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { ApiKey, AuthField } from "@/types";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { TextField, TextArea } from "@/components/ui/TextField";
import { Select } from "@/components/ui/Select";
import { AUTH_FIELD_OPTIONS, kindKey, validateKeyFormat } from "@/lib/defaults";
import { useT } from "@/i18n";
import { useAppStore } from "@/store/useAppStore";
import { toast } from "@/store/useToastStore";

interface KeyFormModalProps {
  open: boolean;
  onClose: () => void;
  editing?: ApiKey | null;
}

export function KeyFormModal({ open, onClose, editing }: KeyFormModalProps) {
  const t = useT();
  const settings = useAppStore((s) => s.settings);
  const addKey = useAppStore((s) => s.addKey);
  const updateKey = useAppStore((s) => s.updateKey);

  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [url, setUrl] = useState("");
  const [authField, setAuthField] = useState<AuthField>(settings.defaultAuthField);
  const [note, setNote] = useState("");
  const [reveal, setReveal] = useState(false);
  const [touched, setTouched] = useState(false);

  // Sync form state whenever the modal opens (for both add & edit).
  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? "");
    setKey(editing?.key ?? "");
    setUrl(editing?.url ?? "");
    setAuthField(editing?.authField ?? settings.defaultAuthField);
    setNote(editing?.note ?? "");
    setReveal(false);
    setTouched(false);
  }, [open, editing, settings.defaultAuthField]);

  const validation = validateKeyFormat(key);
  const keyError =
    touched && key && !validation.valid && validation.reasonKey
      ? t(validation.reasonKey)
      : undefined;
  const authHint = AUTH_FIELD_OPTIONS.find((o) => o.value === authField)?.hintKey;

  const submit = () => {
    setTouched(true);
    if (!name.trim()) {
      toast.warning(t("keyform.errNoName"));
      return;
    }
    if (!key.trim() || !validation.valid) {
      toast.warning(
        t("keyform.errBadKey"),
        validation.reasonKey ? t(validation.reasonKey) : undefined,
      );
      return;
    }
    const payload = {
      name: name.trim(),
      key: key.trim(),
      url: url.trim() || undefined,
      authField,
      note: note.trim() || undefined,
    };
    if (editing) {
      updateKey(editing.id, payload);
      toast.success(t("keyform.updated"), name.trim());
    } else {
      addKey(payload);
      toast.success(t("keyform.added"), name.trim());
    }
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? t("keyform.editTitle") : t("keyform.addTitle")}
      description={t("keyform.desc")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={submit}>{editing ? t("common.save") : t("common.add")}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <TextField
          label={t("keyform.name")}
          required
          placeholder={t("keyform.namePlaceholder")}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <div className="relative">
          <TextField
            label="API Key"
            required
            type={reveal ? "text" : "password"}
            placeholder={t("keyform.keyPlaceholder")}
            value={key}
            error={keyError}
            hint={
              !keyError && key && validation.valid && validation.kind
                ? t("keyform.recognized", { kind: t(kindKey(validation.kind)) })
                : t("keyform.keyHint")
            }
            onChange={(e) => setKey(e.target.value)}
            onBlur={() => setTouched(true)}
          />
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            className="absolute right-3 top-[34px] text-muted hover:text-text"
            aria-label={reveal ? t("keyform.hide") : t("keyform.reveal")}
          >
            {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>

        <TextField
          label={t("keyform.url")}
          placeholder={settings.defaultBaseUrl}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          hint={t("keyform.urlHint")}
        />

        <Select
          label={t("keyform.authField")}
          value={authField}
          onValueChange={(v) => setAuthField(v as AuthField)}
          options={AUTH_FIELD_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
          hint={authHint ? t(authHint) : undefined}
        />

        <TextArea
          label={t("keyform.note")}
          rows={2}
          placeholder={t("keyform.notePlaceholder")}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
    </Modal>
  );
}

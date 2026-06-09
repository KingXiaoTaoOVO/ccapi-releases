import { useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ClipboardPaste, FileUp, Globe, Trash2, WandSparkles as Wand2 } from "lucide-react";
import type { ImportedKey } from "@/types";
import { cn } from "@/lib/cn";
import { maskKey } from "@/lib/format";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { TextField, TextArea } from "@/components/ui/TextField";
import { Select } from "@/components/ui/Select";
import {
  parseClipboard,
  parseFile,
  parseText,
  type Delimiter,
} from "@/services/importParser";
import { useT } from "@/i18n";
import { useAppStore } from "@/store/useAppStore";
import { toast } from "@/store/useToastStore";

interface ImportModalProps {
  open: boolean;
  onClose: () => void;
}

type Tab = "paste" | "file";

export function ImportModal({ open, onClose }: ImportModalProps) {
  const t = useT();
  const importKeys = useAppStore((s) => s.importKeys);
  const [tab, setTab] = useState<Tab>("paste");
  const [text, setText] = useState("");
  const [delimiter, setDelimiter] = useState<Delimiter>("auto");
  const [rows, setRows] = useState<ImportedKey[]>([]);
  const [prefix, setPrefix] = useState("");
  const [batchUrl, setBatchUrl] = useState("");
  const [sourceLabel, setSourceLabel] = useState("");

  const validCount = useMemo(
    () => rows.filter((r) => r.valid && r.selected).length,
    [rows],
  );

  const reset = () => {
    setText("");
    setRows([]);
    setPrefix("");
    setBatchUrl("");
    setSourceLabel("");
  };

  const close = () => {
    reset();
    onClose();
  };

  const parsePaste = () => {
    const parsed = delimiter === "auto" ? parseClipboard(text) : parseText(text, delimiter);
    setRows(parsed);
    setSourceLabel(t("import.clipboardSource"));
    if (parsed.length === 0) toast.warning(t("import.noKeys"));
  };

  const pickFile = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [
          { name: t("import.fileFilter"), extensions: ["txt", "csv", "json"] },
          { name: t("import.allFiles"), extensions: ["*"] },
        ],
      });
      if (!selected || Array.isArray(selected)) return;
      const parsed = await parseFile(selected);
      setRows(parsed);
      setSourceLabel(selected.split(/[\\/]/).pop() ?? selected);
      setTab("file");
      if (parsed.length === 0) toast.warning(t("import.noKeysFile"));
    } catch (e) {
      toast.error(t("import.readFailed"), String(e));
    }
  };

  const patchRow = (id: string, patch: Partial<ImportedKey>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const applyPrefix = () => {
    if (!prefix.trim()) return;
    setRows((rs) => rs.map((r, i) => ({ ...r, name: `${prefix.trim()} ${i + 1}` })));
  };

  const commit = () => {
    const url = batchUrl.trim();
    const prepared = url ? rows.map((r) => ({ ...r, url })) : rows;
    const n = importKeys(prepared);
    if (n > 0) {
      toast.success(t("import.done"), t("import.doneDesc", { n }));
      close();
    } else {
      toast.warning(t("import.nothingTitle"), t("import.nothingDesc"));
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={t("import.title")}
      description={t("import.desc")}
      size="xl"
      footer={
        <>
          <span className="mr-auto text-xs text-muted">
            {t("import.summary", { total: rows.length, valid: validCount })}
          </span>
          <Button variant="ghost" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button onClick={commit} disabled={validCount === 0}>
            {t("import.commit", { n: validCount })}
          </Button>
        </>
      }
    >
      {/* method tabs */}
      <div className="mb-4 flex gap-2">
        <TabButton active={tab === "paste"} onClick={() => setTab("paste")} icon={ClipboardPaste}>
          {t("import.tabPaste")}
        </TabButton>
        <TabButton active={tab === "file"} onClick={() => setTab("file")} icon={FileUp}>
          {t("import.tabFile")}
        </TabButton>
      </div>

      {tab === "paste" ? (
        <div className="space-y-3">
          <TextArea
            rows={5}
            placeholder={t("import.pastePlaceholder")}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex items-end gap-3">
            <div className="w-44">
              <Select
                label={t("import.delimiter")}
                value={delimiter}
                onValueChange={(v) => setDelimiter(v as Delimiter)}
                options={[
                  { value: "auto", label: t("import.delimiter.auto") },
                  { value: "newline", label: t("import.delimiter.newline") },
                  { value: "comma", label: t("import.delimiter.comma") },
                  { value: "space", label: t("import.delimiter.space") },
                ]}
              />
            </div>
            <Button variant="secondary" onClick={parsePaste} disabled={!text.trim()}>
              {t("import.parse")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border bg-surface-2/50 p-8 text-center">
          <FileUp className="mx-auto h-8 w-8 text-muted" />
          <p className="mt-2 text-sm text-muted">{t("import.dropHint")}</p>
          <Button className="mx-auto mt-4" variant="secondary" onClick={pickFile}>
            {t("import.browse")}
          </Button>
        </div>
      )}

      {/* preview */}
      {rows.length > 0 && (
        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium">
              {t("import.preview")}
              {sourceLabel && (
                <span className="ml-2 text-xs text-muted">
                  {t("import.from", { name: sourceLabel })}
                </span>
              )}
            </p>
            <div className="flex items-end gap-2">
              <TextField
                placeholder={t("import.prefixPlaceholder")}
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                className="h-8 w-40 py-1"
              />
              <Button size="sm" variant="subtle" onClick={applyPrefix}>
                <Wand2 className="h-3.5 w-3.5" /> {t("import.apply")}
              </Button>
            </div>
          </div>

          {/* batch URL — applied to every imported key */}
          <label className="mb-2.5 flex items-center gap-2 rounded-lg border border-border bg-surface-2/40 px-2.5 py-1.5">
            <Globe className="h-4 w-4 shrink-0 text-muted" />
            <span className="shrink-0 text-xs text-muted">{t("import.batchUrl")}</span>
            <input
              value={batchUrl}
              onChange={(e) => setBatchUrl(e.target.value)}
              placeholder={t("import.batchUrlPlaceholder")}
              className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted/70"
            />
          </label>

          <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
            {rows.map((r) => (
              <div
                key={r.id}
                className={cn(
                  "flex items-center gap-2 rounded-lg border bg-surface-2/60 px-2.5 py-2",
                  r.valid ? "border-border" : "border-danger/40 bg-danger/5",
                )}
              >
                <input
                  type="checkbox"
                  checked={r.selected}
                  disabled={!r.valid}
                  onChange={(e) => patchRow(r.id, { selected: e.target.checked })}
                  className="h-4 w-4 accent-[rgb(var(--primary))]"
                />
                <input
                  value={r.name}
                  onChange={(e) => patchRow(r.id, { name: e.target.value })}
                  placeholder={t("import.namePlaceholder")}
                  className="w-36 shrink-0 rounded-md border border-border bg-surface px-2 py-1 text-xs outline-none focus:border-primary/60"
                />
                <code className="flex-1 truncate font-mono text-xs text-muted">
                  {maskKey(r.key)}
                </code>
                {r.valid ? (
                  <span className="shrink-0 text-[11px] text-success">{t("import.valid")}</span>
                ) : (
                  <span
                    className="shrink-0 text-[11px] text-danger"
                    title={r.reasonKey ? t(r.reasonKey) : undefined}
                  >
                    {r.reasonKey ? t(r.reasonKey) : t("import.invalid")}
                  </span>
                )}
                <button
                  onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}
                  className="shrink-0 rounded p-1 text-muted hover:text-danger"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof FileUp;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
        active
          ? "bg-primary/10 text-primary"
          : "text-muted hover:bg-surface-2 hover:text-text",
      )}
    >
      <Icon className="h-4 w-4" />
      {children}
    </button>
  );
}

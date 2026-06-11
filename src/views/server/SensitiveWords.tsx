import { useCallback, useEffect, useState } from "react";
import { Filter, Save } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { apiGet, apiPatch } from "@/services/apiClient";
import { notify } from "@/services/notify";

export function SensitiveWords() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 12 });
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await apiGet<{ words: string[] }>("/api/admin/sensitive-words");
      setText(r.words.join("\n"));
    } catch (e: any) {
      notify("error", t("common.loadFail"), e?.message);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    const words = text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    setSaving(true);
    try {
      const r = await apiPatch<{ ok: true; count: number }>(
        "/api/admin/sensitive-words",
        { words },
      );
      notify("success", t("words.saved", { n: String(r.count) }));
    } catch (e: any) {
      notify("error", t("common.saveFail"), e?.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div ref={ref} className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="flex items-end justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <Filter className="h-5 w-5 text-primary" />
              {t("words.title")}
            </h1>
            <p className="mt-1 text-sm text-muted">{t("words.subtitle")}</p>
          </div>
          <Button onClick={() => void save()} loading={saving}>
            <Save className="h-3.5 w-3.5" />
            {t("common.save")}
          </Button>
        </header>

        <section className="rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
          <p className="mb-2 text-xs text-muted">{t("words.hint")}</p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={18}
            placeholder={t("words.placeholder")}
            className="w-full rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 font-mono text-xs outline-none focus:border-primary/60"
            spellCheck={false}
          />
        </section>
      </div>
    </div>
  );
}

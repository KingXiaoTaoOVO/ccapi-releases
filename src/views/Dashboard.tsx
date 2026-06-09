import { useMemo, useState } from "react";
import {
  Activity,
  CheckSquare,
  Download,
  Layers,
  ListChecks,
  Plus,
  RefreshCw,
  Repeat,
  Search,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Upload,
  Wallet,
  X,
  Zap,
} from "lucide-react";
import type { ApiKey, KeyStatus } from "@/types";
import { cn } from "@/lib/cn";
import { STATUS_GROUPS } from "@/lib/status";
import { Button } from "@/components/ui/Button";
import { KeyCard } from "@/components/KeyCard/KeyCard";
import { KeyFormModal } from "@/components/KeyForm/KeyForm";
import { ImportModal } from "@/components/ImportModal/ImportModal";
import { useCountUp, useStaggerChildren } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import { useAppStore } from "@/store/useAppStore";
import { toast } from "@/store/useToastStore";

const STRATEGY_SHORT_KEY: Record<string, MessageKey> = {
  sequential: "strategy.sequential.short",
  quota: "strategy.quota.short",
  latency: "strategy.latency.short",
};

function applySpotlight(e: React.MouseEvent<HTMLDivElement>) {
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--mx", `${e.clientX - r.left}px`);
  el.style.setProperty("--my", `${e.clientY - r.top}px`);
}

export function Dashboard() {
  const t = useT();
  const keys = useAppStore((s) => s.keys);
  const settings = useAppStore((s) => s.settings);
  const checkAll = useAppStore((s) => s.checkAll);
  const rotateNext = useAppStore((s) => s.rotateNext);
  const removeKeys = useAppStore((s) => s.removeKeys);
  const bulkChecking = useAppStore((s) => s.bulkChecking);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ApiKey | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [filter, setFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);


  const counts = useMemo(() => {
    const tally: Record<string, number> = {};
    for (const g of STATUS_GROUPS) {
      tally[g.key] = keys.filter((k) => g.members.includes(k.status)).length;
    }
    return tally;
  }, [keys]);

  const stats = useMemo(() => {
    const active = keys.filter((k) => k.status === "active").length;
    const trouble = keys.filter((k) =>
      ["cooling", "exhausted", "invalid", "low"].includes(k.status),
    ).length;
    const remainingUsd = keys.reduce((s, k) => s + (k.quotaRemainingUsd ?? 0), 0);
    const hasQuota = keys.some((k) => k.quotaRemainingUsd != null);
    return { total: keys.length, active, trouble, remainingUsd, hasQuota };
  }, [keys]);

  const filtered = useMemo(() => {
    let list = [...keys].sort((a, b) => a.order - b.order);
    if (filter !== "all") {
      const group = STATUS_GROUPS.find((g) => g.key === filter);
      if (group) list = list.filter((k) => group.members.includes(k.status as KeyStatus));
    }
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (k) =>
          k.name.toLowerCase().includes(q) ||
          k.note?.toLowerCase().includes(q) ||
          k.key.toLowerCase().includes(q),
      );
    }
    return list;
  }, [keys, filter, query]);

  const gridRef = useStaggerChildren<HTMLDivElement>("[data-anim]", [
    filtered.length,
    filter,
    query,
  ]);

  // ----- multi-select / batch delete -----
  const allVisibleSelected = filtered.length > 0 && filtered.every((k) => selected.has(k.id));

  const enterSelect = () => {
    setSelectMode(true);
    setSelected(new Set());
    setConfirmBulkDelete(false);
  };
  const exitSelect = () => {
    setSelectMode(false);
    setSelected(new Set());
    setConfirmBulkDelete(false);
  };
  const toggleSelect = (id: string) => {
    setConfirmBulkDelete(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleSelectAll = () => {
    setConfirmBulkDelete(false);
    setSelected(allVisibleSelected ? new Set() : new Set(filtered.map((k) => k.id)));
  };
  const deleteSelected = () => {
    if (selected.size === 0) return;
    if (!confirmBulkDelete) {
      setConfirmBulkDelete(true);
      return;
    }
    const n = selected.size;
    removeKeys([...selected]);
    toast.success(t("dash.deletedN", { n }));
    exitSelect();
  };

  const openAdd = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (k: ApiKey) => {
    setEditing(k);
    setFormOpen(true);
  };

  const exportKeys = async () => {
    if (keys.length === 0) return;
    const data = keys.map(({ name, key, url, authField, note }) => ({
      name,
      key,
      url,
      authField,
      note,
    }));
    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      toast.success(t("dash.exported"), t("dash.exportedDesc", { n: keys.length }));
    } catch {
      toast.error(t("dash.exportFailed"));
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* stat cards */}
      {keys.length > 0 && (
        <div className="grid grid-cols-2 gap-3 px-6 pt-5 lg:grid-cols-4">
          <StatCard label={t("dash.statTotal")} value={stats.total} icon={Layers} tone="primary" />
          <StatCard label={t("dash.statActive")} value={stats.active} icon={ShieldCheck} tone="success" />
          <StatCard label={t("dash.statTrouble")} value={stats.trouble} icon={TriangleAlert} tone="warning" />
          <StatCard
            label={t("dash.statQuota")}
            value={stats.hasQuota ? stats.remainingUsd : 0}
            icon={Wallet}
            tone="info"
            prefix={stats.hasQuota ? "$" : ""}
            decimals={2}
            placeholder={stats.hasQuota ? undefined : "—"}
          />
        </div>
      )}

      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-3 px-6 py-4">
        <div className="flex items-center gap-1.5 rounded-xl bg-surface-2/70 p-1 backdrop-blur-sm">
          <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
            {t("dash.filterAll")} {keys.length}
          </FilterChip>
          {STATUS_GROUPS.map((g) => (
            <FilterChip
              key={g.key}
              active={filter === g.key}
              onClick={() => setFilter(g.key)}
            >
              {t(g.labelKey)} {counts[g.key] ?? 0}
            </FilterChip>
          ))}
        </div>

        {keys.length > 0 && (
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("dash.searchPlaceholder")}
              className="h-9 w-44 rounded-xl border border-border bg-surface-2/70 pl-9 pr-3 text-sm outline-none backdrop-blur-sm transition-[box-shadow,border-color] focus:border-primary/60 focus:shadow-[0_0_0_3px_rgb(var(--primary)/0.18)]"
            />
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          {selectMode ? (
            <>
              <span className="text-xs text-muted">
                {t("dash.selected", { n: selected.size })}
              </span>
              <Button variant="secondary" size="sm" onClick={toggleSelectAll}>
                <CheckSquare className="h-3.5 w-3.5" />
                {allVisibleSelected ? t("dash.deselectAll") : t("dash.selectAll")}
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={selected.size === 0}
                onClick={deleteSelected}
                onMouseLeave={() => setConfirmBulkDelete(false)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {confirmBulkDelete
                  ? t("dash.confirmDeleteN", { n: selected.size })
                  : `${t("dash.deleteSelected")} (${selected.size})`}
              </Button>
              <Button variant="ghost" size="sm" onClick={exitSelect}>
                <X className="h-3.5 w-3.5" /> {t("dash.exitSelect")}
              </Button>
            </>
          ) : (
            <>
              <span className="hidden items-center gap-1 rounded-lg bg-surface-2/70 px-2.5 py-1.5 text-xs text-muted lg:flex">
                <Repeat className="h-3.5 w-3.5" />
                {t(STRATEGY_SHORT_KEY[settings.rotationStrategy] ?? "strategy.sequential.short")}
              </span>
              <Button variant="secondary" size="sm" onClick={() => rotateNext(t("dash.rotateManual"))}>
                <Zap className="h-3.5 w-3.5" /> {t("dash.rotate")}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => checkAll()} loading={bulkChecking}>
                <RefreshCw className="h-3.5 w-3.5" /> {t("dash.checkAll")}
              </Button>
              {keys.length > 0 && (
                <Button variant="ghost" size="icon" onClick={exportKeys} title={t("dash.export")}>
                  <Download className="h-4 w-4" />
                </Button>
              )}
              {keys.length > 0 && (
                <Button variant="ghost" size="icon" onClick={enterSelect} title={t("dash.multiSelect")}>
                  <ListChecks className="h-4 w-4" />
                </Button>
              )}
              <Button variant="secondary" size="sm" onClick={() => setImportOpen(true)}>
                <Upload className="h-3.5 w-3.5" /> {t("dash.import")}
              </Button>
              <Button size="sm" onClick={openAdd}>
                <Plus className="h-3.5 w-3.5" /> {t("dash.addShort")}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* list — pt leaves headroom so the active card's "active" badge isn't
          clipped by the scroll container when the card lifts on hover */}
      <div className="flex-1 overflow-y-auto px-6 pb-6 pt-6">
        {keys.length === 0 ? (
          <EmptyState onAdd={openAdd} onImport={() => setImportOpen(true)} />
        ) : filtered.length === 0 ? (
          <div className="grid h-full place-items-center text-sm text-muted">
            {t("dash.noMatch")}
          </div>
        ) : (
          <div
            ref={gridRef}
            className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
          >
            {filtered.map((k) => (
              <KeyCard
                key={k.id}
                apiKey={k}
                onEdit={openEdit}
                selectMode={selectMode}
                selected={selected.has(k.id)}
                onToggleSelect={toggleSelect}
              />
            ))}
          </div>
        )}
      </div>

      <KeyFormModal open={formOpen} onClose={() => setFormOpen(false)} editing={editing} />
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  );
}

const TONE_BG: Record<string, string> = {
  primary: "bg-primary/12 text-primary",
  success: "bg-success/12 text-success",
  warning: "bg-warning/12 text-warning",
  info: "bg-info/12 text-info",
};

function StatCard({
  label,
  value,
  icon: Icon,
  tone,
  prefix = "",
  decimals = 0,
  placeholder,
}: {
  label: string;
  value: number;
  icon: typeof Layers;
  tone: keyof typeof TONE_BG;
  prefix?: string;
  decimals?: number;
  placeholder?: string;
}) {
  const v = useCountUp(value);
  return (
    <div
      onMouseMove={applySpotlight}
      className="glass-soft spotlight flex items-center gap-3 p-4"
    >
      <div className={cn("grid h-11 w-11 shrink-0 place-items-center rounded-xl", TONE_BG[tone])}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0">
        <p className="truncate text-xs text-muted">{label}</p>
        <p className="text-xl font-semibold tabular-nums">
          {placeholder ?? `${prefix}${v.toFixed(decimals)}`}
        </p>
      </div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
        active ? "bg-surface text-text shadow-soft" : "text-muted hover:text-text",
      )}
    >
      {children}
    </button>
  );
}

function EmptyState({
  onAdd,
  onImport,
}: {
  onAdd: () => void;
  onImport: () => void;
}) {
  const t = useT();
  return (
    <div className="grid h-full place-items-center">
      <div className="text-center">
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-primary/10 text-primary">
          <Activity className="h-8 w-8" />
        </div>
        <h3 className="mt-4 text-lg font-semibold">{t("dash.emptyTitle")}</h3>
        <p className="mt-1 text-sm text-muted">
          {t("dash.emptyDesc")}
        </p>
        <div className="mt-5 flex items-center justify-center gap-2">
          <Button onClick={onAdd}>
            <Plus className="h-4 w-4" /> {t("dash.emptyAdd")}
          </Button>
          <Button variant="secondary" onClick={onImport}>
            <Upload className="h-4 w-4" /> {t("dash.emptyImport")}
          </Button>
        </div>
      </div>
    </div>
  );
}

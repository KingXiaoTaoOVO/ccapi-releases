import { Plus, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import { useT } from "@/i18n";
import { Button } from "@/components/ui/Button";

interface PrimaryAction {
  label: string;
  onClick: () => void;
  icon?: typeof Plus;
}

interface WorkspacePageProps {
  /** Optional search box (omit `search` to hide it). */
  search?: {
    value: string;
    onChange: (next: string) => void;
    placeholder?: string;
  };
  primaryAction?: PrimaryAction;
  toolbarExtra?: React.ReactNode;
  /** Children fill the scroll area below the toolbar. */
  children: React.ReactNode;
  /** Custom class for the scroll container (e.g. for grids). */
  bodyClassName?: string;
}

/**
 * Two-row page chrome shared by all workspace views (Chat, Skills, MCP, Rules,
 * Agents, Tasks). The first row hosts an optional search field, custom toolbar
 * controls and a primary "New" action; the body below scrolls independently.
 */
export function WorkspacePage({
  search,
  primaryAction,
  toolbarExtra,
  children,
  bodyClassName,
}: WorkspacePageProps) {
  const t = useT();
  const Icon = primaryAction?.icon ?? Plus;
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border/60 px-6 py-4">
        {search && (
          <label className="relative flex h-10 min-w-[220px] flex-1 items-center sm:max-w-sm">
            <Search className="pointer-events-none absolute left-3 h-4 w-4 text-muted" />
            <input
              value={search.value}
              onChange={(e) => search.onChange(e.target.value)}
              placeholder={search.placeholder ?? t("ws.searchPlaceholder")}
              className={cn(
                "no-drag h-10 w-full rounded-xl border border-border bg-surface-2 pl-9 pr-3 text-sm",
                "placeholder:text-muted/70 outline-none transition-[box-shadow,border-color] duration-200",
                "focus:border-primary/60 focus:shadow-[0_0_0_3px_rgb(var(--primary)/0.18)]",
              )}
            />
          </label>
        )}
        {toolbarExtra}
        {primaryAction && (
          <Button onClick={primaryAction.onClick} className="ml-auto" variant="primary">
            <Icon className="h-4 w-4" />
            {primaryAction.label}
          </Button>
        )}
      </div>
      <div className={cn("min-h-0 flex-1 overflow-y-auto px-6 py-5", bodyClassName)}>
        {children}
      </div>
    </div>
  );
}

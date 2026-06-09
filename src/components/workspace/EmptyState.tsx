import type { LucideIcon } from "lucide-react";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}

export function EmptyState({ icon: Icon, title, hint, action }: EmptyStateProps) {
  return (
    <div className="grid h-full place-items-center px-6 py-16">
      <div className="flex max-w-md flex-col items-center text-center">
        <div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-border bg-surface-2/60 text-primary">
          <Icon className="h-6 w-6" />
        </div>
        <h3 className="text-base font-semibold">{title}</h3>
        {hint && <p className="mt-1.5 text-sm text-muted">{hint}</p>}
        {action && <div className="mt-5">{action}</div>}
      </div>
    </div>
  );
}

import { Server, User } from "lucide-react";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { useModeStore } from "@/store/useModeStore";
import { cn } from "@/lib/cn";

export function ModeSelect() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 16 });
  const select = useModeStore((s) => s.selectMode);

  const cards: Array<{
    mode: "server" | "client";
    icon: typeof Server;
    titleKey: string;
    descKey: string;
    accent: string;
  }> = [
    {
      mode: "server",
      icon: Server,
      titleKey: "mode.server.title",
      descKey: "mode.server.desc",
      accent: "from-primary/30 to-accent/20",
    },
    {
      mode: "client",
      icon: User,
      titleKey: "mode.client.title",
      descKey: "mode.client.desc",
      accent: "from-info/30 to-primary/20",
    },
  ];

  return (
    <div ref={ref} className="grid h-full place-items-center px-6 py-10">
      <div className="w-full max-w-3xl space-y-8">
        <header className="text-center">
          <h1 className="text-2xl font-semibold text-text">
            {t("mode.title")}
          </h1>
          <p className="mt-2 text-sm text-muted">{t("mode.subtitle")}</p>
        </header>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {cards.map((c) => (
            <button
              key={c.mode}
              onClick={() => void select(c.mode)}
              className={cn(
                "group relative flex flex-col gap-4 overflow-hidden rounded-2xl border border-border bg-surface/60 p-6 text-left",
                "shadow-card backdrop-blur-xl transition-all duration-300",
                "hover:-translate-y-1 hover:border-primary/40 hover:shadow-glow",
              )}
            >
              <div
                className={cn(
                  "absolute inset-0 -z-10 bg-gradient-to-br opacity-50 transition-opacity group-hover:opacity-100",
                  c.accent,
                )}
              />
              <div className="grid h-12 w-12 place-items-center rounded-2xl bg-surface-2 text-primary">
                <c.icon className="h-6 w-6" />
              </div>
              <div>
                <div className="text-base font-semibold text-text">
                  {t(c.titleKey as any)}
                </div>
                <div className="mt-1.5 text-xs leading-relaxed text-muted">
                  {t(c.descKey as any)}
                </div>
              </div>
            </button>
          ))}
        </div>
        <p className="text-center text-xs text-muted/70">{t("mode.hint")}</p>
      </div>
    </div>
  );
}

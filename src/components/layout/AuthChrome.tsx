import { LanguageToggle } from "@/components/LanguageToggle";
import { ThemeToggle } from "@/components/ThemeToggle/ThemeToggle";

/** 浮动在右上角的主题/语言切换按钮，给未登录界面用。 */
export function AuthChrome() {
  return (
    <div className="pointer-events-none fixed right-4 top-4 z-50 flex items-center gap-2">
      <div className="pointer-events-auto">
        <ThemeToggle />
      </div>
      <div className="pointer-events-auto">
        <LanguageToggle />
      </div>
    </div>
  );
}

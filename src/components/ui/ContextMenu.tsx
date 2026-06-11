import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import gsap from "gsap";
import {
  Clipboard,
  ClipboardCheck,
  ClipboardPaste,
  Copy,
  RefreshCw,
  Scissors,
  TextSelect,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { prefersReducedMotion } from "@/hooks/useGSAPAnim";

/**
 * 自定义右键菜单 —— 接管全局 `contextmenu` 事件，禁用浏览器默认菜单，
 * 替换成与软件 UI 风格统一的玻璃态浮层。
 *
 * 用法：
 * - 在 App 根节点用 <ContextMenuProvider> 包住整棵树，全局生效
 * - 任意子组件用 useContextMenu({ items }) 注册自定义条目，
 *   或调用 useContextMenu().show(e, items) 命令式弹出
 */

export interface ContextMenuItem {
  /** 唯一标识，用 React key */
  id: string;
  label: string;
  /** lucide 图标组件（可选） */
  icon?: React.ComponentType<{ className?: string }>;
  /** 快捷键提示，例如 "Ctrl+C" */
  shortcut?: string;
  /** 点击后执行；返回 Promise 会被等待但不阻塞菜单关闭 */
  onSelect: () => void | Promise<void>;
  disabled?: boolean;
  /** 危险动作：显示为红色 */
  danger?: boolean;
  /** 在该项之上插入分隔线 */
  separatorBefore?: boolean;
}

interface ContextMenuApi {
  /** 主动在指定位置打开菜单（用于自定义触发器） */
  open: (x: number, y: number, items: ContextMenuItem[]) => void;
  close: () => void;
}

const Ctx = createContext<ContextMenuApi | null>(null);

export function useContextMenuApi(): ContextMenuApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useContextMenuApi must be used inside <ContextMenuProvider>");
  return v;
}

/**
 * 给某个 ref 绑定自定义右键菜单。返回的 onContextMenu 直接挂到目标元素上。
 * items 可以是静态数组，或返回数组的函数（基于事件目标动态构造）。
 */
export function useContextMenu(
  items: ContextMenuItem[] | ((e: React.MouseEvent) => ContextMenuItem[]),
): { onContextMenu: (e: React.MouseEvent) => void } {
  const api = useContextMenuApi();
  return {
    onContextMenu: (e) => {
      const list = typeof items === "function" ? items(e) : items;
      if (!list || list.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      api.open(e.clientX, e.clientY, list);
    },
  };
}

// ============================================================================
// 默认菜单条目 —— 当事件目标是输入框 / 选区 / 普通区域时给出合适的剪贴板动作
// ============================================================================

async function readClipboard(): Promise<string | null> {
  try {
    if (navigator.clipboard?.readText) {
      return await navigator.clipboard.readText();
    }
  } catch {
    /* 拒绝/不支持 */
  }
  return null;
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function isEditable(el: EventTarget | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return true;
  if (el.isContentEditable) return true;
  return false;
}

function getSelectionText(): string {
  return (window.getSelection()?.toString() ?? "").trim();
}

function buildDefaultItems(target: EventTarget | null): ContextMenuItem[] {
  const editable = isEditable(target);
  const selected = getSelectionText();
  const items: ContextMenuItem[] = [];

  if (editable) {
    const el = target as HTMLInputElement | HTMLTextAreaElement;
    const hasSel =
      el.selectionStart != null &&
      el.selectionEnd != null &&
      el.selectionStart !== el.selectionEnd;
    items.push(
      {
        id: "cut",
        label: "剪切",
        icon: Scissors,
        shortcut: "Ctrl+X",
        disabled: !hasSel,
        onSelect: async () => {
          if (!hasSel) return;
          const text = el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0);
          if (await writeClipboard(text)) {
            const start = el.selectionStart ?? 0;
            const end = el.selectionEnd ?? 0;
            el.value = el.value.slice(0, start) + el.value.slice(end);
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.setSelectionRange(start, start);
          }
        },
      },
      {
        id: "copy",
        label: "复制",
        icon: Copy,
        shortcut: "Ctrl+C",
        disabled: !hasSel,
        onSelect: async () => {
          if (!hasSel) return;
          await writeClipboard(
            el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0),
          );
        },
      },
      {
        id: "paste",
        label: "粘贴",
        icon: ClipboardPaste,
        shortcut: "Ctrl+V",
        onSelect: async () => {
          const text = await readClipboard();
          if (text == null) return;
          const start = el.selectionStart ?? el.value.length;
          const end = el.selectionEnd ?? el.value.length;
          el.value = el.value.slice(0, start) + text + el.value.slice(end);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          const caret = start + text.length;
          el.setSelectionRange(caret, caret);
        },
      },
      {
        id: "selectAll",
        label: "全选",
        icon: TextSelect,
        shortcut: "Ctrl+A",
        separatorBefore: true,
        onSelect: () => {
          el.select();
        },
      },
    );
  } else if (selected) {
    items.push({
      id: "copy-sel",
      label: "复制",
      icon: Copy,
      shortcut: "Ctrl+C",
      onSelect: async () => {
        await writeClipboard(selected);
      },
    });
  } else {
    // 空白区域：给个粘贴入口（如果剪贴板有东西就有意义），以及刷新
    items.push({
      id: "paste-blank",
      label: "粘贴到光标",
      icon: Clipboard,
      onSelect: async () => {
        const text = await readClipboard();
        if (text == null) return;
        const active = document.activeElement;
        if (isEditable(active)) {
          const el = active as HTMLInputElement | HTMLTextAreaElement;
          const start = el.selectionStart ?? el.value.length;
          const end = el.selectionEnd ?? el.value.length;
          el.value = el.value.slice(0, start) + text + el.value.slice(end);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
      },
    });
  }

  items.push({
    id: "reload",
    label: "重新加载",
    icon: RefreshCw,
    shortcut: "Ctrl+R",
    separatorBefore: true,
    onSelect: () => window.location.reload(),
  });

  return items;
}

// ============================================================================
// Provider
// ============================================================================

interface MenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

export function ContextMenuProvider({ children }: { children: React.ReactNode }) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [adjusted, setAdjusted] = useState<{ x: number; y: number } | null>(null);

  const open = useCallback((x: number, y: number, items: ContextMenuItem[]) => {
    setAdjusted(null);
    setMenu({ x, y, items });
  }, []);

  const close = useCallback(() => {
    setMenu(null);
    setAdjusted(null);
  }, []);

  // 全局拦截 —— 没有事先 stopPropagation 的右键都走这里，弹默认菜单
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      e.preventDefault();
      open(e.clientX, e.clientY, buildDefaultItems(e.target));
    };
    window.addEventListener("contextmenu", onCtx);
    return () => window.removeEventListener("contextmenu", onCtx);
  }, [open]);

  // 打开后：左/Esc/滚动 关闭
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onScroll = () => close();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [menu, close]);

  // 边界检测：菜单超出视窗时调整定位
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const r = menuRef.current.getBoundingClientRect();
    const margin = 8;
    let x = menu.x;
    let y = menu.y;
    if (x + r.width + margin > window.innerWidth) {
      x = Math.max(margin, window.innerWidth - r.width - margin);
    }
    if (y + r.height + margin > window.innerHeight) {
      y = Math.max(margin, window.innerHeight - r.height - margin);
    }
    if (x !== menu.x || y !== menu.y) setAdjusted({ x, y });
  }, [menu]);

  // 入场动画
  useLayoutEffect(() => {
    if (!menu || !menuRef.current || prefersReducedMotion()) return;
    gsap.fromTo(
      menuRef.current,
      { opacity: 0, y: -6, scale: 0.97 },
      {
        opacity: 1,
        y: 0,
        scale: 1,
        duration: 0.18,
        ease: "power3.out",
        transformOrigin: "top left",
      },
    );
    const items = menuRef.current.querySelectorAll("[data-ctx-item]");
    if (items.length > 0) {
      gsap.fromTo(
        items,
        { opacity: 0, x: -4 },
        { opacity: 1, x: 0, duration: 0.16, stagger: 0.02, ease: "power2.out" },
      );
    }
  }, [menu]);

  const api = useMemo<ContextMenuApi>(() => ({ open, close }), [open, close]);

  const pos = adjusted ?? (menu ? { x: menu.x, y: menu.y } : null);

  return (
    <Ctx.Provider value={api}>
      {children}
      {menu &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className={cn(
              "glass fixed z-[100] min-w-[180px] max-w-[280px] rounded-xl p-1.5",
              "shadow-card backdrop-blur-2xl",
            )}
            style={{ left: pos.x, top: pos.y }}
            onContextMenu={(e) => e.preventDefault()}
          >
            {menu.items.map((item, idx) => (
              <ItemRow
                key={item.id ?? idx}
                item={item}
                onPick={() => {
                  if (item.disabled) return;
                  close();
                  // run after close so any focus restoration etc. behaves
                  void Promise.resolve().then(() => item.onSelect());
                }}
              />
            ))}
          </div>,
          document.body,
        )}
    </Ctx.Provider>
  );
}

function ItemRow({
  item,
  onPick,
}: {
  item: ContextMenuItem;
  onPick: () => void;
}) {
  const Icon = item.icon ?? ClipboardCheck;
  return (
    <>
      {item.separatorBefore && (
        <div className="my-1 h-px bg-border/50" aria-hidden />
      )}
      <button
        data-ctx-item
        type="button"
        disabled={item.disabled}
        onClick={onPick}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors",
          "outline-none",
          item.disabled
            ? "cursor-not-allowed text-muted/50"
            : item.danger
              ? "text-danger hover:bg-danger/10"
              : "text-text hover:bg-surface-2",
        )}
      >
        <Icon
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            item.disabled
              ? "text-muted/40"
              : item.danger
                ? "text-danger"
                : "text-muted",
          )}
        />
        <span className="flex-1 truncate">{item.label}</span>
        {item.shortcut && (
          <span
            className={cn(
              "ml-2 shrink-0 font-mono text-[10px]",
              item.disabled ? "text-muted/40" : "text-muted/70",
            )}
          >
            {item.shortcut}
          </span>
        )}
      </button>
    </>
  );
}

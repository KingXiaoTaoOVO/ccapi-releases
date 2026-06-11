import { useEffect, useState } from "react";
import { User as UserIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { readUserAvatar } from "@/services/tauri";

const SIZES = {
  sm: "h-8 w-8",
  md: "h-12 w-12",
  lg: "h-20 w-20",
  xl: "h-28 w-28",
};

/**
 * 全局头像组件。每个 user_id 从本地 APP_DATA/avatars/ 读一次（带 cache busting key）。
 * 没头像 / 读失败时回退到首字母+用户图标。
 */
export function Avatar({
  userId,
  username,
  size = "md",
  className,
  bust,
}: {
  userId: number | null | undefined;
  username?: string;
  size?: keyof typeof SIZES;
  className?: string;
  /** 改变它强制重新读（上传后让父级 +1） */
  bust?: number | string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!userId) {
      setSrc(null);
      return;
    }
    let alive = true;
    setLoading(true);
    readUserAvatar(userId)
      .then((s) => {
        if (alive) setSrc(s);
      })
      .catch(() => {
        if (alive) setSrc(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [userId, bust]);

  const letter = (username?.[0] ?? "?").toUpperCase();

  return (
    <div
      className={cn(
        "grid place-items-center rounded-2xl bg-primary/15 text-primary overflow-hidden",
        SIZES[size],
        className,
      )}
    >
      {src ? (
        <img
          src={src}
          alt={username ?? "avatar"}
          className="h-full w-full object-cover"
        />
      ) : loading ? (
        <span className="text-xs text-muted">…</span>
      ) : username ? (
        <span className="text-sm font-semibold">{letter}</span>
      ) : (
        <UserIcon className="h-1/2 w-1/2" />
      )}
    </div>
  );
}

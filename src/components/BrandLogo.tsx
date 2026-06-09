import faviconUrl from "@/assets/favicon.ico";
import { cn } from "@/lib/cn";

interface BrandLogoProps {
  /** Pixel size of the square logo. */
  size?: number;
  className?: string;
  /** Rounded container with a soft surface backing. */
  framed?: boolean;
}

/**
 * App brand mark, sourced from the project favicon so the in-app logo,
 * the browser tab icon, and the OS taskbar icon all stay in sync.
 */
export function BrandLogo({ size = 36, framed = true, className }: BrandLogoProps) {
  const img = (
    <img
      src={faviconUrl}
      alt="CCAPI"
      width={size}
      height={size}
      draggable={false}
      className={cn("object-contain", !framed && className)}
      style={{ width: size, height: size }}
    />
  );

  if (!framed) return img;

  return (
    <div
      className={cn(
        "grid place-items-center rounded-xl border border-border bg-surface shadow-soft",
        className,
      )}
      style={{ width: size + 12, height: size + 12 }}
    >
      {img}
    </div>
  );
}

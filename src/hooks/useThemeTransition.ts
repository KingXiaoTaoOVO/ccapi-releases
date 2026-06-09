import { useCallback } from "react";
import gsap from "gsap";
import type { Theme } from "@/types";
import { useThemeStore } from "@/store/useThemeStore";
import { prefersReducedMotion } from "./useGSAPAnim";

function ensureOverlay(): HTMLElement {
  let el = document.getElementById("theme-transition-overlay");
  if (!el) {
    el = document.createElement("div");
    el.id = "theme-transition-overlay";
    document.body.appendChild(el);
  }
  return el;
}

/**
 * Returns a function that switches the theme with a GSAP ripple emanating from
 * the interaction origin, layered on top of the base CSS colour transition.
 */
export function useThemeTransition() {
  const setTheme = useThemeStore((s) => s.setTheme);

  return useCallback(
    (theme: Theme, origin?: { x: number; y: number }) => {
      if (prefersReducedMotion()) {
        setTheme(theme);
        return;
      }

      const x = origin?.x ?? window.innerWidth - 56;
      const y = origin?.y ?? 56;
      const overlay = ensureOverlay();
      overlay.style.background = `radial-gradient(circle at ${x}px ${y}px, rgb(var(--primary) / 0.45), rgb(var(--accent) / 0.12) 35%, transparent 60%)`;

      // Apply the new palette underneath; CSS transitions ease the recolor,
      // the overlay adds a soft flash of the brand colour over the origin.
      setTheme(theme);

      gsap.fromTo(
        overlay,
        { opacity: 0, scale: 0.6, transformOrigin: `${x}px ${y}px` },
        {
          opacity: 1,
          scale: 1,
          duration: 0.28,
          ease: "power2.out",
          yoyo: true,
          repeat: 1,
          onComplete: () => {
            overlay.style.opacity = "0";
          },
        },
      );
    },
    [setTheme],
  );
}

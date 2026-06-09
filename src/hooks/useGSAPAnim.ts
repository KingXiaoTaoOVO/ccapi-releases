import { useEffect, useLayoutEffect, useRef, useState } from "react";
import gsap from "gsap";

/** Respect the OS "reduce motion" accessibility setting. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

/** Fade + slide a single element in on mount. */
export function useEntrance<T extends HTMLElement>(opts?: {
  delay?: number;
  y?: number;
}) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;
    const ctx = gsap.context(() => {
      gsap.from(el, {
        opacity: 0,
        y: opts?.y ?? 16,
        duration: 0.55,
        ease: "power3.out",
        delay: opts?.delay ?? 0,
      });
    }, el);
    return () => ctx.revert();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return ref;
}

/**
 * Stagger-animate children matching `selector` whenever `deps` change.
 * Used for the dashboard load animation and list re-renders.
 */
export function useStaggerChildren<T extends HTMLElement>(
  selector = "[data-anim]",
  deps: unknown[] = [],
) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;
    const ctx = gsap.context(() => {
      gsap.from(selector, {
        opacity: 0,
        y: 18,
        duration: 0.5,
        ease: "power3.out",
        stagger: 0.06,
        clearProps: "opacity,transform",
      });
    }, el);
    return () => ctx.revert();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

/** Hover micro-interaction: subtle lift + scale, reversible on leave. */
export function useGSAPHover<T extends HTMLElement>(opts?: {
  y?: number;
  scale?: number;
}) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;
    const y = opts?.y ?? -4;
    const scale = opts?.scale ?? 1.012;
    const enter = () =>
      gsap.to(el, { y, scale, duration: 0.3, ease: "power2.out" });
    const leave = () =>
      gsap.to(el, { y: 0, scale: 1, duration: 0.4, ease: "power2.out" });
    el.addEventListener("mouseenter", enter);
    el.addEventListener("mouseleave", leave);
    return () => {
      el.removeEventListener("mouseenter", enter);
      el.removeEventListener("mouseleave", leave);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return ref;
}

/** Pulse an element (scale bounce) whenever `trigger` changes. */
export function usePulse<T extends HTMLElement>(trigger: unknown) {
  const ref = useRef<T>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;
    gsap.fromTo(
      el,
      { scale: 0.7 },
      { scale: 1, duration: 0.5, ease: "elastic.out(1, 0.5)" },
    );
  }, [trigger]);
  return ref;
}

/**
 * Cursor-following spotlight. Attach the returned ref to an element with the
 * `.spotlight` class; updates the --mx / --my CSS variables on mouse move.
 */
export function useSpotlight<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;
    const move = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty("--mx", `${e.clientX - r.left}px`);
      el.style.setProperty("--my", `${e.clientY - r.top}px`);
    };
    el.addEventListener("mousemove", move);
    return () => el.removeEventListener("mousemove", move);
  }, []);
  return ref;
}

/** Animate a numeric value with an easing count-up. Returns the live value. */
export function useCountUp(value: number, duration = 0.9): number {
  const [display, setDisplay] = useState(value);
  const proxy = useRef({ v: value });
  useEffect(() => {
    if (prefersReducedMotion()) {
      setDisplay(value);
      return;
    }
    const obj = proxy.current;
    const tween = gsap.to(obj, {
      v: value,
      duration,
      ease: "power2.out",
      onUpdate: () => setDisplay(obj.v),
    });
    return () => {
      tween.kill();
    };
  }, [value, duration]);
  return display;
}

export { gsap };

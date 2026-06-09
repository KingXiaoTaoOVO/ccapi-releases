import { useCallback } from "react";
import { create } from "zustand";
import { type Lang, type MessageKey, messages } from "./messages";

const STORAGE_KEY = "ccapi.lang";

function detectInitial(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    /* ignore */
  }
  if (typeof navigator !== "undefined" && navigator.language) {
    return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
  }
  return "zh";
}

type Params = Record<string, string | number>;

function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, k) =>
    params[k] !== undefined ? String(params[k]) : `{${k}}`,
  );
}

/** Pure translate against an explicit language. */
export function translate(lang: Lang, key: MessageKey, params?: Params): string {
  const table = messages[lang] as Record<string, string>;
  const fallback = messages.zh as Record<string, string>;
  const raw = table[key] ?? fallback[key] ?? key;
  return interpolate(raw, params);
}

interface I18nState {
  lang: Lang;
  setLang: (lang: Lang) => void;
  toggle: () => void;
  /** Reactive translate (re-renders consumers on language change). */
  t: (key: MessageKey, params?: Params) => string;
}

export const useI18n = create<I18nState>((set, get) => ({
  lang: detectInitial(),
  setLang: (lang) => {
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      /* ignore */
    }
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    set({ lang });
  },
  toggle: () => get().setLang(get().lang === "zh" ? "en" : "zh"),
  t: (key, params) => translate(get().lang, key, params),
}));

/**
 * Imperative translate for non-React code (stores, services).
 * NOT reactive — reads the current language at call time. Use for toast
 * strings and other one-shot messages produced outside the render tree.
 */
export function t(key: MessageKey, params?: Params): string {
  return translate(useI18n.getState().lang, key, params);
}

/**
 * Hook returning a reactive `t`. Subscribes to `lang` (not the stable `s.t`
 * reference) so EVERY component using it re-renders the moment the language
 * switches — otherwise components that don't otherwise re-render stay stuck in
 * the previous language.
 */
export function useT(): (key: MessageKey, params?: Params) => string {
  const lang = useI18n((s) => s.lang);
  return useCallback(
    (key: MessageKey, params?: Params) => translate(lang, key, params),
    [lang],
  );
}

/** Current language as a reactive value. */
export function useLang(): Lang {
  return useI18n((s) => s.lang);
}

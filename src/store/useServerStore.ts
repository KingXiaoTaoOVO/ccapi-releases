import { create } from "zustand";

export type AdminView =
  | "dashboard"
  | "users"
  | "roles"
  | "codes"
  | "tiers"
  | "invitations"
  | "usage"
  | "channels"
  | "models"
  | "userGroups"
  | "tokens"
  | "audit"
  | "serverConfig"
  | "settings"
  | "site"
  | "mail"
  | "payment"
  | "oauth"
  | "words"
  | "rateLimits"
  | "orders"
  | "asyncTasks"
  | "sysAdvanced"
  | "orgs"
  | "prefill";

interface ServerStore {
  view: AdminView;
  setView: (v: AdminView) => void;
}

export const useServerStore = create<ServerStore>((set) => ({
  view: "dashboard",
  setView: (v) => set({ view: v }),
}));

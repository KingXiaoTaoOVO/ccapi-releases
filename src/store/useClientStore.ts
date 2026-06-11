import { create } from "zustand";

export type ClientView =
  | "dashboard"
  | "quota"
  | "redeem"
  | "invite"
  | "tokens"
  | "playground"
  | "profile"
  | "proxy"
  | "security"
  | "recharge"
  | "subscription"
  | "chat"
  | "agents"
  | "skills"
  | "mcp"
  | "rules";

interface ClientStore {
  view: ClientView;
  setView: (v: ClientView) => void;
}

export const useClientStore = create<ClientStore>((set) => ({
  view: "dashboard",
  setView: (v) => set({ view: v }),
}));

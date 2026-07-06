import { create } from "zustand";
import { persist } from "zustand/middleware";
import { CREDIT_PACKS, HISTORY_SEED } from "./mockData";
import type {
  BillingCycle,
  CheckoutItem,
  HistoryEntry,
  PlanTier,
  Toast,
} from "./types";

export const FREE_CHECKS_LIMIT = 3;

export type BalanceMode = "unlimited" | "credits" | "free-meter";

interface AppState {
  plan: PlanTier;
  billingCycle: BillingCycle;
  freeChecksUsed: number;
  credits: number;
  history: HistoryEntry[];
  pendingCheckoutItem: CheckoutItem | null;
  hasPendingCheck: boolean;
  pendingDocLabel: string | null;
  lastCheckoutStatus: "success" | "declined" | null;
  toasts: Toast[];

  balanceMode: () => BalanceMode;
  remaining: () => number;
  requestCheck: (docLabel?: string) => boolean;
  clearPendingCheck: () => void;
  selectCheckoutItem: (item: CheckoutItem) => void;
  completePurchase: () => void;
  addHistoryEntry: (entry: HistoryEntry) => void;
  pushToast: (toast: Omit<Toast, "id">) => void;
  dismissToast: (id: string) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      plan: "free",
      billingCycle: "monthly",
      freeChecksUsed: 2,
      credits: 0,
      history: HISTORY_SEED,
      pendingCheckoutItem: null,
      hasPendingCheck: false,
      pendingDocLabel: null,
      lastCheckoutStatus: null,
      toasts: [],

      balanceMode: () => {
        const { plan, credits } = get();
        if (plan !== "free") return "unlimited";
        if (credits > 0) return "credits";
        return "free-meter";
      },

      remaining: () => {
        const { plan, credits, freeChecksUsed } = get();
        if (plan !== "free") return Infinity;
        if (credits > 0) return credits;
        return Math.max(0, FREE_CHECKS_LIMIT - freeChecksUsed);
      },

      requestCheck: (docLabel) => {
        const { plan, credits, freeChecksUsed } = get();
        if (docLabel) set({ pendingDocLabel: docLabel });
        if (plan !== "free") return true;
        if (credits > 0) {
          set({ credits: credits - 1 });
          return true;
        }
        if (freeChecksUsed < FREE_CHECKS_LIMIT) {
          set({ freeChecksUsed: freeChecksUsed + 1 });
          return true;
        }
        set({ hasPendingCheck: true });
        return false;
      },

      clearPendingCheck: () => set({ hasPendingCheck: false, pendingDocLabel: null }),

      selectCheckoutItem: (item) => set({ pendingCheckoutItem: item, lastCheckoutStatus: null }),

      completePurchase: () => {
        const { pendingCheckoutItem } = get();
        if (!pendingCheckoutItem) return;
        if (pendingCheckoutItem.kind === "plan") {
          set({
            plan: pendingCheckoutItem.plan,
            billingCycle: pendingCheckoutItem.billingCycle,
            lastCheckoutStatus: "success",
          });
        } else {
          const pack = CREDIT_PACKS.find((p) => p.id === pendingCheckoutItem.packId);
          if (pack) {
            set((s) => ({ credits: s.credits + pack.checks, lastCheckoutStatus: "success" }));
          }
        }
      },

      addHistoryEntry: (entry) => set((s) => ({ history: [entry, ...s.history] })),

      pushToast: (toast) =>
        set((s) => ({
          toasts: [...s.toasts, { ...toast, id: Math.random().toString(36).slice(2) }],
        })),

      dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
    }),
    {
      name: "etymos-demo-state",
      partialize: (s) => ({
        plan: s.plan,
        billingCycle: s.billingCycle,
        freeChecksUsed: s.freeChecksUsed,
        credits: s.credits,
        history: s.history,
      }),
    },
  ),
);

export function planLabel(plan: PlanTier): string {
  if (plan === "free") return "Free";
  if (plan === "student") return "Student Premium";
  return "Professional";
}

export function historyRetentionLabel(plan: PlanTier): string {
  return plan === "free" ? "7 days" : "12 months";
}

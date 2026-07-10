import { create } from "zustand";
import { persist } from "zustand/middleware";
import { CREDIT_PACKS, HISTORY_SEED } from "./mockData";
import type {
  BillingCycle,
  CheckedDocument,
  CheckoutItem,
  HistoryEntry,
  PlanTier,
  Toast,
} from "./types";

export const PLAN_DOC_LIMITS: Record<PlanTier, number> = {
  free: 2,
  student: 10,
  professional: 70,
};
export const PLAN_WORD_LIMITS: Record<PlanTier, number> = {
  free: 3000,
  student: 10000,
  professional: 15000,
};
export const PLAN_PERIOD_DAYS = 30;

export type BalanceMode = "credits" | "plan-meter";

export function planDocLimit(plan: PlanTier): number {
  return PLAN_DOC_LIMITS[plan];
}

export function planWordLimit(plan: PlanTier): number {
  return PLAN_WORD_LIMITS[plan];
}

const DEFAULT_PROJECTS = Array.from(
  new Set(HISTORY_SEED.map((h) => h.project).filter(Boolean)),
) as string[];

interface AppState {
  plan: PlanTier;
  billingCycle: BillingCycle;
  checksUsedThisPeriod: number;
  credits: number;
  history: HistoryEntry[];
  trash: HistoryEntry[];
  projects: string[];
  checkedDocuments: Record<string, CheckedDocument>;
  hasCompletedFirstCheck: boolean;
  planPeriodStart: string;
  pendingCheckoutItem: CheckoutItem | null;
  hasPendingCheck: boolean;
  pendingDocLabel: string | null;
  lastCheckoutStatus: "success" | "declined" | null;
  studentVerified: boolean;
  toasts: Toast[];

  balanceMode: () => BalanceMode;
  remaining: () => number;
  requestCheck: (docLabel?: string, count?: number) => boolean;
  clearPendingCheck: () => void;
  selectCheckoutItem: (item: CheckoutItem) => void;
  completePurchase: () => void;
  addHistoryEntry: (entry: HistoryEntry) => void;
  addHistoryEntries: (entries: HistoryEntry[]) => void;
  cancelSubscription: () => void;
  recordCheckedDocument: (doc: CheckedDocument) => void;
  markFirstCheckComplete: () => void;
  addProject: (name: string) => void;
  deleteProjects: (names: string[]) => void;
  moveHistoryEntry: (id: string, project: string) => void;
  moveToTrash: (id: string) => void;
  restoreFromTrash: (id: string) => void;
  permanentlyDeleteTrash: (id: string) => void;
  planResetInfo: () => { daysLeft: number; resetDate: Date };
  rolloverPlanPeriodIfNeeded: () => void;
  completeStudentVerification: () => void;
  pushToast: (toast: Omit<Toast, "id">) => void;
  dismissToast: (id: string) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      plan: "free",
      billingCycle: "monthly",
      checksUsedThisPeriod: 1,
      credits: 0,
      history: HISTORY_SEED,
      trash: [],
      projects: DEFAULT_PROJECTS,
      checkedDocuments: {},
      hasCompletedFirstCheck: false,
      planPeriodStart: new Date().toISOString(),
      pendingCheckoutItem: null,
      hasPendingCheck: false,
      pendingDocLabel: null,
      lastCheckoutStatus: null,
      studentVerified: false,
      toasts: [],

      balanceMode: () => {
        const { credits } = get();
        if (credits > 0) return "credits";
        return "plan-meter";
      },

      remaining: () => {
        const { plan, credits, checksUsedThisPeriod } = get();
        if (credits > 0) return credits;
        return Math.max(0, PLAN_DOC_LIMITS[plan] - checksUsedThisPeriod);
      },

      requestCheck: (docLabel, count = 1) => {
        const { plan, credits, checksUsedThisPeriod } = get();
        if (docLabel) set({ pendingDocLabel: docLabel });
        if (credits > 0) {
          if (credits < count) {
            set({ hasPendingCheck: true });
            return false;
          }
          set({ credits: credits - count });
          return true;
        }
        if (checksUsedThisPeriod + count <= PLAN_DOC_LIMITS[plan]) {
          set({ checksUsedThisPeriod: checksUsedThisPeriod + count });
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
            checksUsedThisPeriod: 0,
            planPeriodStart: new Date().toISOString(),
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

      addHistoryEntries: (entries) => set((s) => ({ history: [...entries, ...s.history] })),

      cancelSubscription: () =>
        set({ plan: "free", checksUsedThisPeriod: 0, planPeriodStart: new Date().toISOString() }),

      recordCheckedDocument: (doc) =>
        set((s) => ({ checkedDocuments: { ...s.checkedDocuments, [doc.id]: doc } })),

      markFirstCheckComplete: () => set({ hasCompletedFirstCheck: true }),

      addProject: (name) =>
        set((s) => (s.projects.includes(name) ? s : { projects: [...s.projects, name] })),

      deleteProjects: (names) =>
        set((s) => {
          const nameSet = new Set(names);
          return {
            projects: s.projects.filter((p) => !nameSet.has(p)),
            history: s.history.map((h) =>
              h.project && nameSet.has(h.project) ? { ...h, project: undefined } : h,
            ),
            trash: s.trash.map((h) =>
              h.project && nameSet.has(h.project) ? { ...h, project: undefined } : h,
            ),
          };
        }),

      moveHistoryEntry: (id, project) =>
        set((s) => ({
          history: s.history.map((h) => (h.id === id ? { ...h, project } : h)),
        })),

      moveToTrash: (id) =>
        set((s) => {
          const entry = s.history.find((h) => h.id === id);
          if (!entry) return s;
          return {
            history: s.history.filter((h) => h.id !== id),
            trash: [entry, ...s.trash],
          };
        }),

      restoreFromTrash: (id) =>
        set((s) => {
          const entry = s.trash.find((h) => h.id === id);
          if (!entry) return s;
          return {
            trash: s.trash.filter((h) => h.id !== id),
            history: [entry, ...s.history],
          };
        }),

      permanentlyDeleteTrash: (id) =>
        set((s) => ({ trash: s.trash.filter((h) => h.id !== id) })),

      planResetInfo: () => {
        const { planPeriodStart } = get();
        const start = new Date(planPeriodStart);
        const resetDate = new Date(start);
        resetDate.setDate(resetDate.getDate() + PLAN_PERIOD_DAYS);
        const daysLeft = Math.max(
          0,
          Math.ceil((resetDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)),
        );
        return { daysLeft, resetDate };
      },

      rolloverPlanPeriodIfNeeded: () => {
        const { planPeriodStart } = get();
        const start = new Date(planPeriodStart);
        const next = new Date(start);
        next.setDate(next.getDate() + PLAN_PERIOD_DAYS);
        if (Date.now() >= next.getTime()) {
          set({ planPeriodStart: next.toISOString(), checksUsedThisPeriod: 0 });
        }
      },

      completeStudentVerification: () => set({ studentVerified: true }),

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
        checksUsedThisPeriod: s.checksUsedThisPeriod,
        credits: s.credits,
        history: s.history,
        trash: s.trash,
        projects: s.projects,
        checkedDocuments: s.checkedDocuments,
        hasCompletedFirstCheck: s.hasCompletedFirstCheck,
        planPeriodStart: s.planPeriodStart,
        studentVerified: s.studentVerified,
      }),
    },
  ),
);

export function planLabel(plan: PlanTier): string {
  if (plan === "free") return "Free";
  if (plan === "student") return "Standard";
  return "Premium";
}

export function historyRetentionLabel(plan: PlanTier, hasCredits = false): string {
  if (hasCredits) return "30 days per check";
  if (plan === "free") return "7 days";
  if (plan === "student") return "9 months";
  return "12 months";
}

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  fetchHistory as fetchHistoryEntries,
  fetchTrash as fetchTrashEntries,
  moveDocumentToTrash,
  restoreDocumentFromTrash,
  permanentlyDeleteDocument,
} from "./documentsQueries";
import type {
  BillingCycle,
  CheckedDocument,
  CheckoutItem,
  HistoryEntry,
  PlanTier,
  Toast,
} from "@etymos/shared";

// Hardcoded fallback only — used before configQueries.ts's fetchPlanDefinitions()
// resolves (or if it fails). Once that fetch succeeds, setPlanLimitsFromConfig()
// overwrites these in place with the live plan_definitions.doc_limit/word_limit
// values, which are the actual source of truth.
export const PLAN_DOC_LIMITS: Record<PlanTier, number> = {
  free: 2,
  student: 10,
  professional: 50,
};
export const PLAN_WORD_LIMITS: Record<PlanTier, number> = {
  free: 3000,
  student: 10000,
  professional: 25000,
};
export const PLAN_PERIOD_DAYS = 30;

/** Which of the three independent balances a check should be spent from.
 * "plan" = the plan's monthly doc_limit (checksUsedThisPeriod); "standard"/
 * "premium" = the matching credit-pack balance. The user picks one per check
 * (Upload screen) instead of the old auto-detected single-`credits` model. */
export type BalanceSource = "plan" | "standard" | "premium";

export interface BalanceOption {
  source: BalanceSource;
  label: string;
  remaining: number;
}

export function planDocLimit(plan: PlanTier): number {
  return PLAN_DOC_LIMITS[plan];
}

export function planWordLimit(plan: PlanTier): number {
  return PLAN_WORD_LIMITS[plan];
}

/** Mutates the fallback maps in place so planDocLimit()/planWordLimit() callers
 * (plain functions, not store selectors) see live values without re-plumbing. */
export function setPlanLimitsFromConfig(
  plans: { id: PlanTier; docLimit: number | null; wordLimit: number | null }[],
): void {
  for (const p of plans) {
    if (typeof p.docLimit === "number") PLAN_DOC_LIMITS[p.id] = p.docLimit;
    if (typeof p.wordLimit === "number") PLAN_WORD_LIMITS[p.id] = p.wordLimit;
  }
}

// Multi-project management is gone — every user has a single implicit
// "Default" project. Kept as an array (not a string) so screens that still
// render `projects.map(...)` (History/Upload, pending a follow-up cleanup)
// keep working without a type change.
export const PROJECTS: string[] = ["Default"];

interface AppState {
  plan: PlanTier;
  billingCycle: BillingCycle;
  checksUsedThisPeriod: number;
  standardCredits: number;
  premiumCredits: number;
  selectedBalance: BalanceSource;
  history: HistoryEntry[];
  historyLoading: boolean;
  historyError: string | null;
  trash: HistoryEntry[];
  projects: string[];
  /** Project names the user has created but that have no documents in them
   * yet — since `documents.project` is a plain text column with no backing
   * projects table, an empty project only exists client-side until the
   * first document is assigned to it. Merged with the distinct project
   * names present in `history` by the Documents screen. */
  knownProjects: string[];
  checkedDocuments: Record<string, CheckedDocument>;
  hasCompletedFirstCheck: boolean;
  planPeriodStart: string;
  pendingCheckoutItem: CheckoutItem | null;
  hasPendingCheck: boolean;
  pendingDocLabel: string | null;
  lastCheckoutStatus: "success" | "declined" | null;
  studentVerified: boolean;
  toasts: Toast[];

  /** All three balances at once, for UI that lists them (UsageMeter, the
   * Upload-screen balance picker). */
  balances: () => BalanceOption[];
  /** Remaining amount for one balance; defaults to `selectedBalance`. */
  remaining: (source?: BalanceSource) => number;
  setSelectedBalance: (source: BalanceSource) => void;
  syncFromProfile: (profile: {
    plan: PlanTier;
    billingCycle: BillingCycle | null;
    standardCredits: number;
    premiumCredits: number;
    checksUsedThisPeriod: number;
    planPeriodStart: string;
    studentVerified: boolean;
  }) => void;
  /** Cosmetic local mirror of the server-side deduction in
   * backend/api/usage.py — decrements the chosen balance optimistically so
   * the UI updates immediately; the backend is the actual gate/spend. */
  requestCheck: (source: BalanceSource, docLabel?: string, count?: number) => boolean;
  clearPendingCheck: () => void;
  selectCheckoutItem: (item: CheckoutItem) => void;
  /** `packId` + `checks` are required for `kind: "pack"` purchases — the
   * caller (Checkout screen) resolves both from the live `credit_packs` row
   * it already fetched. `packId` picks which balance column gets credited
   * ("pack-standard" -> standardCredits, "pack-premium" -> premiumCredits). */
  completePurchase: (packId?: string, checks?: number) => void;
  addHistoryEntry: (entry: HistoryEntry) => void;
  addHistoryEntries: (entries: HistoryEntry[]) => void;
  fetchHistory: (userId: string) => Promise<void>;
  cancelSubscription: () => void;
  recordCheckedDocument: (doc: CheckedDocument) => void;
  markFirstCheckComplete: () => void;
  moveToTrash: (id: string) => Promise<void>;
  restoreFromTrash: (id: string) => Promise<void>;
  permanentlyDeleteTrash: (id: string) => Promise<void>;
  /** Registers a freshly created, still-empty project name so it shows up
   * in the Documents screen before any document is assigned to it. */
  addKnownProject: (name: string) => void;
  removeKnownProject: (name: string) => void;
  /** Updates the `project` field on every matching history entry in place
   * (mirrors a `renameProjectDocuments` Supabase call already made by the
   * caller) and renames the entry in `knownProjects` if present. */
  renameProjectInHistory: (oldName: string, newName: string) => void;
  /** Ungroups every history entry in `name` back to the implicit Default
   * bucket (mirrors a `clearProjectFromDocuments` call) and forgets it from
   * `knownProjects`. */
  clearProjectInHistory: (name: string) => void;
  /** Updates a single history entry's `project` field in place (mirrors a
   * `moveDocumentToProject` Supabase call already made by the caller). */
  setDocumentProject: (id: string, project: string | null) => void;
  /** Updates a single history entry's `title` in place (mirrors a
   * `renameDocument` Supabase call already made by the caller). */
  renameDocumentInHistory: (id: string, title: string) => void;
  planResetInfo: () => { daysLeft: number; resetDate: Date };
  rolloverPlanPeriodIfNeeded: () => void;
  completeStudentVerification: () => void;
  pushToast: (toast: Omit<Toast, "id">) => void;
  dismissToast: (id: string) => void;
}

// balances() must return a referentially stable array when its inputs are
// unchanged — otherwise a `useAppStore((s) => s.balances())` selector (see
// UsageMeter) hands React a brand-new snapshot on every call, which makes
// useSyncExternalStore re-render in an infinite loop (React error #185).
let balancesCache: { key: string; value: BalanceOption[] } | null = null;

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      plan: "free",
      billingCycle: "monthly",
      checksUsedThisPeriod: 0,
      standardCredits: 0,
      premiumCredits: 0,
      selectedBalance: "plan",
      history: [],
      historyLoading: false,
      historyError: null,
      trash: [],
      projects: PROJECTS,
      knownProjects: [],
      checkedDocuments: {},
      hasCompletedFirstCheck: false,
      planPeriodStart: new Date().toISOString(),
      pendingCheckoutItem: null,
      hasPendingCheck: false,
      pendingDocLabel: null,
      lastCheckoutStatus: null,
      studentVerified: false,
      toasts: [],

      balances: () => {
        const { plan, standardCredits, premiumCredits, checksUsedThisPeriod } = get();
        const key = `${plan}|${standardCredits}|${premiumCredits}|${checksUsedThisPeriod}`;
        if (balancesCache && balancesCache.key === key) return balancesCache.value;
        const value: BalanceOption[] = [
          {
            source: "plan",
            label: `${planLabel(plan)} plan checks`,
            remaining: Math.max(0, PLAN_DOC_LIMITS[plan] - checksUsedThisPeriod),
          },
          { source: "standard", label: "Standard credits", remaining: standardCredits },
          { source: "premium", label: "Premium credits", remaining: premiumCredits },
        ];
        balancesCache = { key, value };
        return value;
      },

      remaining: (source) => {
        const { plan, standardCredits, premiumCredits, checksUsedThisPeriod, selectedBalance } = get();
        switch (source ?? selectedBalance) {
          case "standard":
            return standardCredits;
          case "premium":
            return premiumCredits;
          default:
            return Math.max(0, PLAN_DOC_LIMITS[plan] - checksUsedThisPeriod);
        }
      },

      setSelectedBalance: (source) => set({ selectedBalance: source }),

      syncFromProfile: (profile) =>
        set({
          plan: profile.plan,
          billingCycle: profile.billingCycle ?? "monthly",
          standardCredits: profile.standardCredits,
          premiumCredits: profile.premiumCredits,
          checksUsedThisPeriod: profile.checksUsedThisPeriod,
          planPeriodStart: profile.planPeriodStart,
          studentVerified: profile.studentVerified,
        }),

      requestCheck: (source, docLabel, count = 1) => {
        const { plan, standardCredits, premiumCredits, checksUsedThisPeriod } = get();
        if (docLabel) set({ pendingDocLabel: docLabel });

        if (source === "standard") {
          if (standardCredits < count) {
            set({ hasPendingCheck: true });
            return false;
          }
          set({ standardCredits: standardCredits - count });
          return true;
        }

        if (source === "premium") {
          if (premiumCredits < count) {
            set({ hasPendingCheck: true });
            return false;
          }
          set({ premiumCredits: premiumCredits - count });
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

      completePurchase: (packId, checks) => {
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
        } else if (typeof checks === "number") {
          if (packId === "pack-premium") {
            set((s) => ({ premiumCredits: s.premiumCredits + checks, lastCheckoutStatus: "success" }));
          } else {
            set((s) => ({ standardCredits: s.standardCredits + checks, lastCheckoutStatus: "success" }));
          }
        }
      },

      addHistoryEntry: (entry) => set((s) => ({ history: [entry, ...s.history] })),

      addHistoryEntries: (entries) => set((s) => ({ history: [...entries, ...s.history] })),

      fetchHistory: async (userId) => {
        set({ historyLoading: true, historyError: null });
        try {
          const [history, trash] = await Promise.all([
            fetchHistoryEntries(userId),
            fetchTrashEntries(userId),
          ]);
          set({ history, trash, historyLoading: false });
        } catch (err) {
          set({
            historyLoading: false,
            historyError: err instanceof Error ? err.message : "Failed to load history",
          });
        }
      },

      cancelSubscription: () =>
        set({ plan: "free", checksUsedThisPeriod: 0, planPeriodStart: new Date().toISOString() }),

      recordCheckedDocument: (doc) =>
        set((s) => ({ checkedDocuments: { ...s.checkedDocuments, [doc.id]: doc } })),

      markFirstCheckComplete: () => set({ hasCompletedFirstCheck: true }),

      // These three persist to Supabase first and only mutate local state once
      // the write is confirmed — previously they only ever touched the local
      // history/trash arrays, so a "Delete Forever" (or move-to-trash, or
      // restore) would disappear from the UI but the underlying `documents`
      // row was never updated, reappearing on the next fetchHistory().
      moveToTrash: async (id) => {
        const entry = get().history.find((h) => h.id === id);
        if (!entry) return;
        await moveDocumentToTrash(id);
        set((s) => ({
          history: s.history.filter((h) => h.id !== id),
          trash: [entry, ...s.trash],
        }));
      },

      restoreFromTrash: async (id) => {
        const entry = get().trash.find((h) => h.id === id);
        if (!entry) return;
        await restoreDocumentFromTrash(id);
        set((s) => ({
          trash: s.trash.filter((h) => h.id !== id),
          history: [entry, ...s.history],
        }));
      },

      permanentlyDeleteTrash: async (id) => {
        await permanentlyDeleteDocument(id);
        set((s) => ({ trash: s.trash.filter((h) => h.id !== id) }));
      },

      addKnownProject: (name) =>
        set((s) => (s.knownProjects.includes(name) ? s : { knownProjects: [...s.knownProjects, name] })),

      removeKnownProject: (name) =>
        set((s) => ({ knownProjects: s.knownProjects.filter((p) => p !== name) })),

      renameProjectInHistory: (oldName, newName) =>
        set((s) => ({
          history: s.history.map((h) =>
            (h.project ?? PROJECTS[0]) === oldName ? { ...h, project: newName } : h,
          ),
          knownProjects: s.knownProjects.map((p) => (p === oldName ? newName : p)),
        })),

      clearProjectInHistory: (name) =>
        set((s) => ({
          history: s.history.map((h) =>
            (h.project ?? PROJECTS[0]) === name ? { ...h, project: undefined } : h,
          ),
          knownProjects: s.knownProjects.filter((p) => p !== name),
        })),

      setDocumentProject: (id, project) =>
        set((s) => ({
          history: s.history.map((h) => (h.id === id ? { ...h, project: project ?? undefined } : h)),
        })),

      renameDocumentInHistory: (id, title) =>
        set((s) => ({
          history: s.history.map((h) => (h.id === id ? { ...h, title } : h)),
        })),

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
        standardCredits: s.standardCredits,
        premiumCredits: s.premiumCredits,
        selectedBalance: s.selectedBalance,
        checkedDocuments: s.checkedDocuments,
        hasCompletedFirstCheck: s.hasCompletedFirstCheck,
        planPeriodStart: s.planPeriodStart,
        studentVerified: s.studentVerified,
        knownProjects: s.knownProjects,
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

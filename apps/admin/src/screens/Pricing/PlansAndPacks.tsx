import { useEffect, useState } from "react";
import {
  listPlanDefinitions,
  updatePlanDefinition,
  listCreditPacks,
  updateCreditPack,
} from "../../lib/configQueries";
import type { AdminCreditPack, AdminPlanDefinition } from "../../lib/types";
import { friendlyError } from "../../lib/errors";
import { t } from "../../lib/i18n";

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-caption font-medium text-fg-muted">{t(label)}</label>
      <input
        type="number"
        min={0}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded-control border border-border bg-surface-muted px-3 py-2 text-body text-fg outline-none focus-visible:border-accent"
      />
    </div>
  );
}

export default function PlansAndPacksPage() {
  const [plans, setPlans] = useState<AdminPlanDefinition[]>([]);
  const [packs, setPacks] = useState<AdminCreditPack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listPlanDefinitions(), listCreditPacks()])
      .then(([plans, packs]) => {
        setPlans(plans);
        setPacks(packs);
      })
      .catch((err: unknown) => setError(friendlyError(err)))
      .finally(() => setLoading(false));
  }, []);

  async function savePlan(plan: AdminPlanDefinition) {
    setSavingId(plan.id);
    setError(null);
    try {
      await updatePlanDefinition(plan.id, {
        price_monthly: plan.price_monthly,
        price_annual: plan.price_annual,
        doc_limit: plan.doc_limit,
        word_limit: plan.word_limit,
      });
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setSavingId(null);
    }
  }

  async function savePack(pack: AdminCreditPack) {
    setSavingId(pack.id);
    setError(null);
    try {
      await updateCreditPack(pack.id, { price: pack.price, checks: pack.checks });
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setSavingId(null);
    }
  }

  if (loading) return <p className="text-body text-fg-muted">{t("Loading…")}</p>;

  return (
    <div className="space-y-6">
      {error && <p className="text-caption text-destructive">{error}</p>}

      {plans.length === 0 && packs.length === 0 && (
        <div className="rounded-card border border-border bg-surface p-6 text-body text-fg-subtle">
          {t("No pricing data found. Run")}{" "}<code className="font-mono">{t("supabase/seed.sql")}</code> {" "}{t("to seed the current plans.")}</div>
      )}

      {plans.length > 0 && (
        <div>
          <h2 className="text-h2 font-semibold text-fg">{t("Plans")}</h2>
          <div className="mt-3 space-y-3">
            {plans.map((plan) => (
              <div key={plan.id} className="rounded-card border border-border bg-surface p-5 shadow-card">
                <p className="text-body font-medium text-fg capitalize">{t(plan.name)}</p>
                <div className="mt-3 grid grid-cols-4 gap-3">
                  <NumberField
                    label={t("Price / month (VND)")}
                    value={plan.price_monthly}
                    onChange={(v) => setPlans((p) => p.map((x) => (x.id === plan.id ? { ...x, price_monthly: v } : x)))}
                  />
                  <NumberField
                    label={t("Price / year (VND)")}
                    value={plan.price_annual}
                    onChange={(v) => setPlans((p) => p.map((x) => (x.id === plan.id ? { ...x, price_annual: v } : x)))}
                  />
                  <NumberField
                    label={t("Doc limit / month")}
                    value={plan.doc_limit ?? 0}
                    onChange={(v) => setPlans((p) => p.map((x) => (x.id === plan.id ? { ...x, doc_limit: v } : x)))}
                  />
                  <NumberField
                    label={t("Word limit / doc")}
                    value={plan.word_limit ?? 0}
                    onChange={(v) => setPlans((p) => p.map((x) => (x.id === plan.id ? { ...x, word_limit: v } : x)))}
                  />
                </div>
                <button
                  type="button"
                  disabled={savingId === plan.id}
                  onClick={() => savePlan(plan)}
                  className="mt-4 cursor-pointer rounded-control bg-accent px-4 py-2 text-body font-semibold text-bg transition hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {savingId === plan.id ? t("Saving…") : t("Save")}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {packs.length > 0 && (
        <div>
          <h2 className="text-h2 font-semibold text-fg">{t("Credit packs")}</h2>
          <div className="mt-3 space-y-3">
            {packs.map((pack) => (
              <div key={pack.id} className="rounded-card border border-border bg-surface p-5 shadow-card">
                <p className="text-body font-medium text-fg">{t(pack.label)}</p>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <NumberField
                    label={t("Price (VND)")}
                    value={pack.price}
                    onChange={(v) => setPacks((p) => p.map((x) => (x.id === pack.id ? { ...x, price: v } : x)))}
                  />
                  <NumberField
                    label={t("Checks included")}
                    value={pack.checks}
                    onChange={(v) => setPacks((p) => p.map((x) => (x.id === pack.id ? { ...x, checks: v } : x)))}
                  />
                </div>
                <button
                  type="button"
                  disabled={savingId === pack.id}
                  onClick={() => savePack(pack)}
                  className="mt-4 cursor-pointer rounded-control bg-accent px-4 py-2 text-body font-semibold text-bg transition hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {savingId === pack.id ? t("Saving…") : t("Save")}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import { Switch } from "../../components/Switch";
import {
  listPlanDefinitions,
  listCreditPacks,
  listPlanDiscounts,
  createPlanDiscount,
  updatePlanDiscount,
  deletePlanDiscount,
  listDiscountCodes,
  createDiscountCode,
  updateDiscountCode,
  deleteDiscountCode,
} from "../../lib/configQueries";
import type {
  AdminCreditPack,
  AdminDiscountCode,
  AdminPlanDefinition,
  AdminPlanDiscount,
  DiscountType,
} from "../../lib/types";
import { friendlyError } from "../../lib/errors";
import { t as tl, currentLocale } from "../../lib/i18n";

function localInputToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function formatSchedule(startsAt: string | null, endsAt: string | null): string {
  if (!startsAt && !endsAt) return tl("Always active");
  const start = startsAt ? new Date(startsAt).toLocaleString(currentLocale()) : tl("now");
  const end = endsAt ? new Date(endsAt).toLocaleString(currentLocale()) : tl("no end date");
  return `${start} → ${end}`;
}

function formatAmount(discountType: DiscountType, amount: number): string {
  return discountType === "percent" ? tl("{{amount}}% off", { amount }) : tl("{{amount}} VND off", { amount: amount.toLocaleString(currentLocale()) });
}

function DiscountTypeAmountFields({
  discountType,
  amount,
  onDiscountTypeChange,
  onAmountChange,
}: {
  discountType: DiscountType;
  amount: number;
  onDiscountTypeChange: (v: DiscountType) => void;
  onAmountChange: (v: number) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <label className="mb-1.5 block text-caption font-medium text-fg-muted">{tl("Discount type")}</label>
        <select
          value={discountType}
          onChange={(e) => onDiscountTypeChange(e.target.value as DiscountType)}
          className="w-full rounded-control border border-border bg-surface-muted px-3 py-2 text-body text-fg outline-none focus-visible:border-accent"
        >
          <option value="percent">{tl("Percent")}</option>
          <option value="fixed">{tl("Fixed amount (VND)")}</option>
        </select>
      </div>
      <div>
        <label className="mb-1.5 block text-caption font-medium text-fg-muted">
          {tl("Amount")}{" "}{discountType === "percent" ? "(%)" : tl("(VND)")}
        </label>
        <input
          type="number"
          min={0}
          value={amount}
          onChange={(e) => onAmountChange(Number(e.target.value))}
          className="w-full rounded-control border border-border bg-surface-muted px-3 py-2 text-body text-fg outline-none focus-visible:border-accent"
        />
      </div>
    </div>
  );
}

function ScheduleFields({
  startsAt,
  endsAt,
  onStartsAtChange,
  onEndsAtChange,
}: {
  startsAt: string;
  endsAt: string;
  onStartsAtChange: (v: string) => void;
  onEndsAtChange: (v: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <label className="mb-1.5 block text-caption font-medium text-fg-muted">{tl("Starts at (optional)")}</label>
        <input
          type="datetime-local"
          value={startsAt}
          onChange={(e) => onStartsAtChange(e.target.value)}
          className="w-full rounded-control border border-border bg-surface-muted px-3 py-2 text-body text-fg outline-none focus-visible:border-accent"
        />
      </div>
      <div>
        <label className="mb-1.5 block text-caption font-medium text-fg-muted">{tl("Ends at (optional)")}</label>
        <input
          type="datetime-local"
          value={endsAt}
          onChange={(e) => onEndsAtChange(e.target.value)}
          className="w-full rounded-control border border-border bg-surface-muted px-3 py-2 text-body text-fg outline-none focus-visible:border-accent"
        />
      </div>
    </div>
  );
}

function PlanPackDiscounts({
  plans,
  packs,
  discounts,
  onChanged,
  onError,
}: {
  plans: AdminPlanDefinition[];
  packs: AdminCreditPack[];
  discounts: AdminPlanDiscount[];
  onChanged: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const targets = [
    ...plans.map((p) => ({ value: `plan:${p.id}`, label: tl("{{name}} (plan)", { name: p.name }), target_type: "plan" as const, target_id: p.id })),
    ...packs.map((p) => ({ value: `pack:${p.id}`, label: tl("{{label}} (pack)", { label: p.label }), target_type: "pack" as const, target_id: p.id })),
  ];

  function targetLabel(targetType: "plan" | "pack", targetId: string): string {
    if (targetType === "plan") {
      const plan = plans.find((p) => p.id === targetId);
      return tl("{{name}} (plan)", { name: plan ? plan.name : targetId });
    }
    const pack = packs.find((p) => p.id === targetId);
    return tl("{{name}} (pack)", { name: pack ? pack.label : targetId });
  }

  const [targetValue, setTargetValue] = useState(targets[0]?.value ?? "");
  const [discountType, setDiscountType] = useState<DiscountType>("percent");
  const [amount, setAmount] = useState(0);
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [active, setActive] = useState(true);
  const [creating, setCreating] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  async function handleCreate() {
    const target = targets.find((t) => t.value === targetValue);
    if (!target || amount <= 0) return;
    setCreating(true);
    try {
      await createPlanDiscount({
        target_type: target.target_type,
        target_id: target.target_id,
        discount_type: discountType,
        amount,
        starts_at: localInputToIso(startsAt),
        ends_at: localInputToIso(endsAt),
        active,
      });
      setAmount(0);
      setStartsAt("");
      setEndsAt("");
      setActive(true);
      await onChanged();
    } catch (err) {
      onError(friendlyError(err));
    } finally {
      setCreating(false);
    }
  }

  async function toggleActive(discount: AdminPlanDiscount, next: boolean) {
    setSavingId(discount.id);
    try {
      await updatePlanDiscount(discount.id, { active: next });
      await onChanged();
    } catch (err) {
      onError(friendlyError(err));
    } finally {
      setSavingId(null);
    }
  }

  async function remove(discount: AdminPlanDiscount) {
    setSavingId(discount.id);
    try {
      await deletePlanDiscount(discount.id);
      await onChanged();
    } catch (err) {
      onError(friendlyError(err));
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-card border border-border bg-surface p-5 shadow-card">
        <h2 className="text-h2 font-semibold text-fg">{tl("New plan/pack discount")}</h2>
        <div className="mt-3 space-y-3">
          <div>
            <label className="mb-1.5 block text-caption font-medium text-fg-muted">{tl("Target")}</label>
            <select
              value={targetValue}
              onChange={(e) => setTargetValue(e.target.value)}
              className="w-full rounded-control border border-border bg-surface-muted px-3 py-2 text-body text-fg outline-none focus-visible:border-accent"
            >
              {targets.map((t) => (
                <option key={t.value} value={t.value}>
                  {tl(t.label)}
                </option>
              ))}
            </select>
          </div>
          <DiscountTypeAmountFields
            discountType={discountType}
            amount={amount}
            onDiscountTypeChange={setDiscountType}
            onAmountChange={setAmount}
          />
          <ScheduleFields startsAt={startsAt} endsAt={endsAt} onStartsAtChange={setStartsAt} onEndsAtChange={setEndsAt} />
          <div className="flex items-center gap-2.5">
            <Switch checked={active} onChange={setActive} />
            <span className="text-body text-fg-muted">{tl("Active")}</span>
          </div>
          <button
            type="button"
            disabled={creating || !targetValue || amount <= 0}
            onClick={handleCreate}
            className="cursor-pointer rounded-control bg-accent px-4 py-2 text-body font-semibold text-bg transition hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {creating ? tl("Creating…") : tl("Create discount")}
          </button>
        </div>
      </div>

      {discounts.length === 0 ? (
        <div className="rounded-card border border-border bg-surface p-6 text-body text-fg-subtle">
          {tl("No plan or pack discounts yet.")}</div>
      ) : (
        <div className="divide-y divide-border rounded-card border border-border bg-surface shadow-card">
          {discounts.map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-4 px-5 py-4">
              <div className="min-w-0">
                <p className="text-body font-medium text-fg">{targetLabel(d.target_type, d.target_id)}</p>
                <p className="mt-0.5 text-caption text-fg-muted">{formatAmount(d.discount_type, d.amount)}</p>
                <p className="mt-0.5 text-caption text-fg-subtle">{formatSchedule(d.starts_at, d.ends_at)}</p>
              </div>
              <div className="flex items-center gap-3">
                <Switch
                  checked={d.active}
                  disabled={savingId === d.id}
                  onChange={(v) => toggleActive(d, v)}
                />
                <button
                  type="button"
                  disabled={savingId === d.id}
                  onClick={() => remove(d)}
                  className="cursor-pointer rounded-control px-3 py-1.5 text-caption font-medium text-destructive transition hover:bg-destructive-bg disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {tl("Delete")}</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DiscountCodes({
  codes,
  onChanged,
  onError,
}: {
  codes: AdminDiscountCode[];
  onChanged: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [code, setCode] = useState("");
  const [discountType, setDiscountType] = useState<DiscountType>("percent");
  const [amount, setAmount] = useState(0);
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [maxRedemptions, setMaxRedemptions] = useState("");
  const [active, setActive] = useState(true);
  const [creating, setCreating] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  async function handleCreate() {
    if (!code.trim() || amount <= 0) return;
    setCreating(true);
    try {
      await createDiscountCode({
        code: code.trim().toUpperCase(),
        discount_type: discountType,
        amount,
        starts_at: localInputToIso(startsAt),
        ends_at: localInputToIso(endsAt),
        max_redemptions: maxRedemptions.trim() ? Number(maxRedemptions) : null,
        active,
      });
      setCode("");
      setAmount(0);
      setStartsAt("");
      setEndsAt("");
      setMaxRedemptions("");
      setActive(true);
      await onChanged();
    } catch (err) {
      onError(friendlyError(err));
    } finally {
      setCreating(false);
    }
  }

  async function toggleActive(discountCode: AdminDiscountCode, next: boolean) {
    setSavingId(discountCode.id);
    try {
      await updateDiscountCode(discountCode.id, { active: next });
      await onChanged();
    } catch (err) {
      onError(friendlyError(err));
    } finally {
      setSavingId(null);
    }
  }

  async function remove(discountCode: AdminDiscountCode) {
    setSavingId(discountCode.id);
    try {
      await deleteDiscountCode(discountCode.id);
      await onChanged();
    } catch (err) {
      onError(friendlyError(err));
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-card border border-border bg-surface p-5 shadow-card">
        <h2 className="text-h2 font-semibold text-fg">{tl("New discount code")}</h2>
        <div className="mt-3 space-y-3">
          <div>
            <label className="mb-1.5 block text-caption font-medium text-fg-muted">{tl("Code")}</label>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder={tl("e.g. WELCOME10")}
              className="w-full rounded-control border border-border bg-surface-muted px-3 py-2 font-mono text-body uppercase text-fg outline-none focus-visible:border-accent"
            />
          </div>
          <DiscountTypeAmountFields
            discountType={discountType}
            amount={amount}
            onDiscountTypeChange={setDiscountType}
            onAmountChange={setAmount}
          />
          <ScheduleFields startsAt={startsAt} endsAt={endsAt} onStartsAtChange={setStartsAt} onEndsAtChange={setEndsAt} />
          <div>
            <label className="mb-1.5 block text-caption font-medium text-fg-muted">
              {tl("Max redemptions (blank = unlimited)")}</label>
            <input
              type="number"
              min={1}
              value={maxRedemptions}
              onChange={(e) => setMaxRedemptions(e.target.value)}
              placeholder={tl("Unlimited")}
              className="w-full rounded-control border border-border bg-surface-muted px-3 py-2 text-body text-fg outline-none focus-visible:border-accent"
            />
          </div>
          <div className="flex items-center gap-2.5">
            <Switch checked={active} onChange={setActive} />
            <span className="text-body text-fg-muted">{tl("Active")}</span>
          </div>
          <button
            type="button"
            disabled={creating || !code.trim() || amount <= 0}
            onClick={handleCreate}
            className="cursor-pointer rounded-control bg-accent px-4 py-2 text-body font-semibold text-bg transition hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {creating ? tl("Creating…") : tl("Create code")}
          </button>
        </div>
      </div>

      {codes.length === 0 ? (
        <div className="rounded-card border border-border bg-surface p-6 text-body text-fg-subtle">
          {tl("No discount codes yet.")}</div>
      ) : (
        <div className="divide-y divide-border rounded-card border border-border bg-surface shadow-card">
          {codes.map((c) => (
            <div key={c.id} className="flex items-center justify-between gap-4 px-5 py-4">
              <div className="min-w-0">
                <p className="font-mono text-body font-medium text-fg">{c.code}</p>
                <p className="mt-0.5 text-caption text-fg-muted">{formatAmount(c.discount_type, c.amount)}</p>
                <p className="mt-0.5 text-caption text-fg-subtle">{formatSchedule(c.starts_at, c.ends_at)}</p>
                <p className="mt-0.5 text-caption text-fg-subtle">
                  {c.max_redemptions === null
                    ? tl("{{redemption_count}} used (unlimited)", { redemption_count: c.redemption_count })
                    : `${c.redemption_count} / ${c.max_redemptions} used`}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <Switch
                  checked={c.active}
                  disabled={savingId === c.id}
                  onChange={(v) => toggleActive(c, v)}
                />
                <button
                  type="button"
                  disabled={savingId === c.id}
                  onClick={() => remove(c)}
                  className="cursor-pointer rounded-control px-3 py-1.5 text-caption font-medium text-destructive transition hover:bg-destructive-bg disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {tl("Delete")}</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function DiscountsPage() {
  const [plans, setPlans] = useState<AdminPlanDefinition[]>([]);
  const [packs, setPacks] = useState<AdminCreditPack[]>([]);
  const [planDiscounts, setPlanDiscounts] = useState<AdminPlanDiscount[]>([]);
  const [discountCodes, setDiscountCodes] = useState<AdminDiscountCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    return Promise.all([listPlanDefinitions(), listCreditPacks(), listPlanDiscounts(), listDiscountCodes()]).then(
      ([plansData, packsData, planDiscountsData, discountCodesData]) => {
        setPlans(plansData);
        setPacks(packsData);
        setPlanDiscounts(planDiscountsData);
        setDiscountCodes(discountCodesData);
      },
    );
  }

  useEffect(() => {
    refresh()
      .catch((err: unknown) => setError(friendlyError(err)))
      .finally(() => setLoading(false));
  }, []);

  async function handleChanged() {
    try {
      await refresh();
    } catch (err) {
      setError(friendlyError(err));
    }
  }

  if (loading) return <p className="text-body text-fg-muted">{tl("Loading…")}</p>;

  return (
    <div className="space-y-8">
      {error && <p className="text-caption text-destructive">{error}</p>}

      <div>
        <h2 className="text-h2 font-semibold text-fg">{tl("Plan & pack discounts")}</h2>
        <p className="mt-1 text-caption text-fg-muted">
          {tl("Apply a direct discount to a specific plan or credit pack, with an optional schedule.")}</p>
        <div className="mt-3">
          <PlanPackDiscounts
            plans={plans}
            packs={packs}
            discounts={planDiscounts}
            onChanged={handleChanged}
            onError={setError}
          />
        </div>
      </div>

      <div>
        <h2 className="text-h2 font-semibold text-fg">{tl("Discount codes")}</h2>
        <p className="mt-1 text-caption text-fg-muted">
          {tl("Codes users can type in at checkout. Redemptions are tracked automatically.")}</p>
        <div className="mt-3">
          <DiscountCodes codes={discountCodes} onChanged={handleChanged} onError={setError} />
        </div>
      </div>
    </div>
  );
}

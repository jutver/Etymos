import { useEffect, useRef, useState, type ReactNode } from "react";
import { PencilSimple, Trash } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { EmailPicker } from "../../components/EmailPicker";
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
  type DiscountCodeInput,
  type PlanDiscountInput,
} from "../../lib/configQueries";
import type {
  AdminCreditPack,
  AdminDiscountCode,
  AdminPlanDefinition,
  AdminPlanDiscount,
  BillingCycle,
  DiscountAudience,
  DiscountType,
} from "../../lib/types";
import { friendlyError } from "../../lib/errors";
import { t as tl, currentLocale } from "../../lib/i18n";
import { pushToast } from "../../lib/toast";
import { DiscountsSkeleton } from "./Skeletons";

const INPUT =
  "w-full rounded-control border border-border bg-surface-muted px-3 py-2 text-body text-fg outline-none focus-visible:border-accent";

// --- conversions --------------------------------------------------------------

function localInputToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const pad = (n: number) => String(n).padStart(2, "0");

function isoToDateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${isoToDateInput(iso)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A picked day as the start, or the very end, of that local day. */
function dateInputToIso(value: string, endOfDay: boolean): string | null {
  if (!value) return null;
  const [y, m, d] = value.split("-").map(Number);
  return (endOfDay ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d)).toISOString();
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(currentLocale());
}

function splitItem(value: string): ["plan" | "pack", string] {
  const at = value.indexOf(":");
  return [value.slice(0, at) as "plan" | "pack", value.slice(at + 1)];
}

// --- the form's state -----------------------------------------------------------

/** One form for both kinds of discount; each ignores the other's fields. */
interface Draft {
  discountType: DiscountType;
  amount: number;
  startsAt: string;
  endsAt: string;
  active: boolean;
  billingCycle: "" | BillingCycle;
  emailsOn: boolean;
  emails: string[];
  signupOn: boolean;
  signupFrom: string;
  signupTo: string;
  newCustomersOnly: boolean;
  // Automatic discounts
  target: string;
  // Codes
  code: string;
  anyItem: boolean;
  items: string[];
  maxRedemptions: string;
}

function emptyDraft(target = ""): Draft {
  return {
    discountType: "percent",
    amount: 0,
    startsAt: "",
    endsAt: "",
    active: true,
    billingCycle: "",
    emailsOn: false,
    emails: [],
    signupOn: false,
    signupFrom: "",
    signupTo: "",
    newCustomersOnly: false,
    target,
    code: "",
    anyItem: true,
    items: [],
    maxRedemptions: "",
  };
}

function draftFrom(row: AdminPlanDiscount | AdminDiscountCode): Draft {
  const base: Draft = {
    ...emptyDraft(),
    discountType: row.discount_type,
    amount: Number(row.amount),
    startsAt: isoToLocalInput(row.starts_at),
    endsAt: isoToLocalInput(row.ends_at),
    active: row.active,
    billingCycle: row.billing_cycle ?? "",
    emailsOn: row.allowed_emails !== null,
    emails: row.allowed_emails ?? [],
    signupOn: row.signup_from !== null || row.signup_to !== null,
    signupFrom: isoToDateInput(row.signup_from),
    signupTo: isoToDateInput(row.signup_to),
    newCustomersOnly: row.new_customers_only,
  };
  if ("code" in row) {
    return {
      ...base,
      code: row.code,
      anyItem: row.targets === null,
      items: row.targets ?? [],
      maxRedemptions: row.max_redemptions === null ? "" : String(row.max_redemptions),
    };
  }
  return { ...base, target: `${row.target_type}:${row.target_id}` };
}

function draftAudience(d: Draft): DiscountAudience {
  return {
    allowed_emails: d.emailsOn ? d.emails : null,
    signup_from: d.signupOn ? dateInputToIso(d.signupFrom, false) : null,
    signup_to: d.signupOn ? dateInputToIso(d.signupTo, true) : null,
    new_customers_only: d.newCustomersOnly,
  };
}

function draftCommon(d: Draft) {
  return {
    discount_type: d.discountType,
    amount: d.amount,
    starts_at: localInputToIso(d.startsAt),
    ends_at: localInputToIso(d.endsAt),
    active: d.active,
    ...draftAudience(d),
  };
}

function toPlanDiscountInput(d: Draft): PlanDiscountInput {
  const [target_type, target_id] = splitItem(d.target);
  return {
    ...draftCommon(d),
    target_type,
    target_id,
    billing_cycle: target_type === "plan" ? d.billingCycle || null : null,
  };
}

function toCodeInput(d: Draft): DiscountCodeInput {
  const max = d.maxRedemptions.trim();
  return {
    ...draftCommon(d),
    code: d.code.trim().toUpperCase(),
    targets: d.anyItem ? null : d.items,
    billing_cycle: d.billingCycle || null,
    max_redemptions: max ? Number(max) : null,
  };
}

/** What's still wrong with the form, if anything. */
function draftProblem(d: Draft, kind: "auto" | "code"): string | null {
  if (kind === "code" && !d.code.trim()) return tl("Enter a code.");
  if (kind === "auto" && !d.target) return tl("Pick a plan or pack.");
  if (kind === "code" && !d.anyItem && d.items.length === 0) return tl("Pick at least one plan or pack.");
  if (!(d.amount > 0)) return tl("Enter an amount above 0.");
  if (d.discountType === "percent" && d.amount > 100) return tl("A percentage can't be more than 100.");
  if (d.startsAt && d.endsAt && d.startsAt > d.endsAt) return tl("The schedule ends before it starts.");
  if (d.emailsOn && d.emails.length === 0) return tl("Add at least one email.");
  if (d.signupOn && !d.signupFrom && !d.signupTo) return tl("Pick at least one sign-up date.");
  if (d.signupOn && d.signupFrom && d.signupTo && d.signupFrom > d.signupTo) {
    return tl("The sign-up dates are the wrong way round.");
  }
  const max = d.maxRedemptions.trim();
  if (kind === "code" && max && !(Number.isInteger(Number(max)) && Number(max) > 0)) {
    return tl("Max redemptions must be a whole number above 0.");
  }
  return null;
}

// --- form pieces ------------------------------------------------------------------

function Label({ children }: { children: ReactNode }) {
  return <label className="mb-1.5 block text-caption font-medium text-fg-muted">{children}</label>;
}

function FormSection({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="grid gap-3 border-t border-border pt-4 first:border-t-0 first:pt-0 md:grid-cols-[11rem_1fr] md:gap-6">
      <div>
        <h3 className="text-body font-semibold text-fg">{title}</h3>
        {hint && <p className="mt-0.5 text-caption text-fg-subtle">{hint}</p>}
      </div>
      <div className="min-w-0 space-y-3">{children}</div>
    </section>
  );
}

function CheckRow({
  checked,
  onChange,
  label,
  hint,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-control border px-3 py-2.5 transition-colors",
        checked ? "border-accent/40 bg-accent-bg" : "border-border",
      )}
    >
      <label className="flex cursor-pointer items-start gap-2.5">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-1 accent-accent"
        />
        <span>
          <span className="block text-body text-fg">{label}</span>
          {hint && <span className="block text-caption text-fg-subtle">{hint}</span>}
        </span>
      </label>
      {checked && children && <div className="mt-3 pl-6">{children}</div>}
    </div>
  );
}

function BillingCycleSelect({ value, onChange }: { value: Draft["billingCycle"]; onChange: (v: Draft["billingCycle"]) => void }) {
  return (
    <div>
      <Label>{tl("Plan billing")}</Label>
      <select value={value} onChange={(e) => onChange(e.target.value as Draft["billingCycle"])} className={INPUT}>
        <option value="">{tl("Monthly and annual")}</option>
        <option value="monthly">{tl("Monthly only")}</option>
        <option value="annual">{tl("Annual only")}</option>
      </select>
    </div>
  );
}

function AudienceFields({ draft, set }: { draft: Draft; set: (patch: Partial<Draft>) => void }) {
  const limited = draft.emailsOn || draft.signupOn || draft.newCustomersOnly;
  return (
    <>
      <CheckRow
        checked={draft.emailsOn}
        onChange={(emailsOn) => set({ emailsOn })}
        label={tl("Only these emails")}
        hint={tl("Accounts signed up with one of these addresses.")}
      >
        <EmailPicker emails={draft.emails} onChange={(emails) => set({ emails })} />
      </CheckRow>
      <CheckRow
        checked={draft.signupOn}
        onChange={(signupOn) => set({ signupOn })}
        label={tl("Only accounts created in a date range")}
        hint={tl("Leave one end blank for “since” or “until”.")}
      >
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{tl("Signed up from")}</Label>
            <input type="date" value={draft.signupFrom} onChange={(e) => set({ signupFrom: e.target.value })} className={INPUT} />
          </div>
          <div>
            <Label>{tl("Signed up until")}</Label>
            <input type="date" value={draft.signupTo} onChange={(e) => set({ signupTo: e.target.value })} className={INPUT} />
          </div>
        </div>
      </CheckRow>
      <CheckRow
        checked={draft.newCustomersOnly}
        onChange={(newCustomersOnly) => set({ newCustomersOnly })}
        label={tl("Only new customers")}
        hint={tl("People who haven't paid for a plan or pack yet.")}
      />
      <p className="text-caption text-fg-subtle">
        {limited ? tl("People must meet every limit that's ticked.") : tl("No limits: everyone can get it.")}
      </p>
    </>
  );
}

interface ItemOption {
  value: string;
  label: string;
}

function DiscountForm({
  kind,
  items,
  draft,
  set,
  editing,
  saving,
  onSave,
  onCancel,
}: {
  kind: "auto" | "code";
  items: ItemOption[];
  draft: Draft;
  set: (patch: Partial<Draft>) => void;
  editing: boolean;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const problem = draftProblem(draft, kind);
  const coversPlans =
    kind === "auto"
      ? draft.target.startsWith("plan:")
      : draft.anyItem || draft.items.some((i) => i.startsWith("plan:"));
  const title = editing
    ? kind === "auto" ? tl("Edit discount") : tl("Edit code")
    : kind === "auto" ? tl("New plan/pack discount") : tl("New discount code");

  return (
    <div className={cn("rounded-card border bg-surface p-5 shadow-card", editing ? "border-accent/50" : "border-border")}>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-h2 font-semibold text-fg">{title}</h2>
        {editing && (
          <button type="button" onClick={onCancel} className="cursor-pointer text-caption font-medium text-fg-muted hover:text-fg">
            {tl("Cancel editing")}
          </button>
        )}
      </div>

      <div className="space-y-4">
        <FormSection title={tl("Discount")}>
          {kind === "auto" ? (
            <div>
              <Label>{tl("Target")}</Label>
              <select value={draft.target} onChange={(e) => set({ target: e.target.value })} className={INPUT}>
                {items.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div>
              <Label>{tl("Code")}</Label>
              <input
                type="text"
                value={draft.code}
                onChange={(e) => set({ code: e.target.value.toUpperCase() })}
                placeholder={tl("e.g. WELCOME10")}
                className={cn(INPUT, "font-mono uppercase")}
              />
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{tl("Discount type")}</Label>
              <select
                value={draft.discountType}
                onChange={(e) => set({ discountType: e.target.value as DiscountType })}
                className={INPUT}
              >
                <option value="percent">{tl("Percent")}</option>
                <option value="fixed">{tl("Fixed amount (VND)")}</option>
              </select>
            </div>
            <div>
              <Label>
                {tl("Amount")} {draft.discountType === "percent" ? "(%)" : tl("(VND)")}
              </Label>
              <input
                type="number"
                min={0}
                max={draft.discountType === "percent" ? 100 : undefined}
                value={draft.amount}
                onChange={(e) => set({ amount: Number(e.target.value) })}
                className={INPUT}
              />
            </div>
          </div>
        </FormSection>

        <FormSection
          title={tl("Applies to")}
          hint={kind === "code" ? tl("What the code can be used on.") : tl("Billing cycles the price drop shows for.")}
        >
          {kind === "code" && (
            <>
              <div className="flex flex-wrap gap-2">
                {[true, false].map((any) => (
                  <label
                    key={String(any)}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-control border px-3 py-1.5 text-body",
                      draft.anyItem === any ? "border-accent/50 bg-accent-bg text-fg" : "border-border text-fg-muted",
                    )}
                  >
                    <input
                      type="radio"
                      checked={draft.anyItem === any}
                      onChange={() => set({ anyItem: any })}
                      className="accent-accent"
                    />
                    {any ? tl("Any plan or pack") : tl("Only some plans or packs")}
                  </label>
                ))}
              </div>
              {!draft.anyItem && (
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {items.map((item) => (
                    <label key={item.value} className="flex cursor-pointer items-center gap-2 text-body text-fg">
                      <input
                        type="checkbox"
                        checked={draft.items.includes(item.value)}
                        onChange={(e) =>
                          set({
                            items: e.target.checked
                              ? [...draft.items, item.value]
                              : draft.items.filter((i) => i !== item.value),
                          })
                        }
                        className="accent-accent"
                      />
                      {item.label}
                    </label>
                  ))}
                </div>
              )}
            </>
          )}
          {coversPlans ? (
            <BillingCycleSelect value={draft.billingCycle} onChange={(billingCycle) => set({ billingCycle })} />
          ) : (
            kind === "auto" && <p className="text-caption text-fg-subtle">{tl("Packs have no billing cycle.")}</p>
          )}
        </FormSection>

        <FormSection title={tl("Who can get it")} hint={tl("Leave everything unticked to offer it to everyone.")}>
          <AudienceFields draft={draft} set={set} />
        </FormSection>

        <FormSection title={tl("When")}>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{tl("Starts at (optional)")}</Label>
              <input type="datetime-local" value={draft.startsAt} onChange={(e) => set({ startsAt: e.target.value })} className={INPUT} />
            </div>
            <div>
              <Label>{tl("Ends at (optional)")}</Label>
              <input type="datetime-local" value={draft.endsAt} onChange={(e) => set({ endsAt: e.target.value })} className={INPUT} />
            </div>
          </div>
          {kind === "code" && (
            <div>
              <Label>{tl("Max redemptions (blank = unlimited)")}</Label>
              <input
                type="number"
                min={1}
                value={draft.maxRedemptions}
                onChange={(e) => set({ maxRedemptions: e.target.value })}
                placeholder={tl("Unlimited")}
                className={INPUT}
              />
            </div>
          )}
          <div className="flex items-center gap-2.5">
            <Switch checked={draft.active} onChange={(active) => set({ active })} />
            <span className="text-body text-fg-muted">{tl("Active")}</span>
          </div>
        </FormSection>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <button
          type="button"
          disabled={saving || problem !== null}
          onClick={onSave}
          className="cursor-pointer rounded-control bg-accent px-4 py-2 text-body font-semibold text-bg transition hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving
            ? tl("Saving…")
            : editing
              ? tl("Save changes")
              : kind === "auto" ? tl("Create discount") : tl("Create code")}
        </button>
        {problem && <p className="text-caption text-fg-subtle">{problem}</p>}
      </div>
    </div>
  );
}

// --- the lists --------------------------------------------------------------------

function statusOf(row: AdminPlanDiscount | AdminDiscountCode): { label: string; tone: string } {
  const now = Date.now();
  if (!row.active) return { label: tl("Off"), tone: "bg-surface-raised text-fg-subtle" };
  if (row.ends_at && new Date(row.ends_at).getTime() < now) return { label: tl("Ended"), tone: "bg-surface-raised text-fg-subtle" };
  if ("code" in row && row.max_redemptions !== null && row.redemption_count >= row.max_redemptions) {
    return { label: tl("Used up"), tone: "bg-warning-bg text-warning" };
  }
  if (row.starts_at && new Date(row.starts_at).getTime() > now) return { label: tl("Scheduled"), tone: "bg-accent-bg text-accent" };
  return { label: tl("Running"), tone: "bg-success-bg text-success" };
}

function formatSchedule(startsAt: string | null, endsAt: string | null): string {
  if (!startsAt && !endsAt) return tl("Always active");
  const start = startsAt ? new Date(startsAt).toLocaleString(currentLocale()) : tl("now");
  const end = endsAt ? new Date(endsAt).toLocaleString(currentLocale()) : tl("no end date");
  return `${start} → ${end}`;
}

function formatAmount(discountType: DiscountType, amount: number): string {
  return discountType === "percent"
    ? tl("{{amount}}% off", { amount })
    : tl("{{amount}} VND off", { amount: Number(amount).toLocaleString(currentLocale()) });
}

/** Short descriptions of a discount's limits, for its row. */
function limitChips(row: AdminPlanDiscount | AdminDiscountCode, itemLabel: (value: string) => string) {
  const chips: { label: string; title?: string }[] = [];
  if ("code" in row && row.targets) chips.push({ label: tl("Only: {{list}}", { list: row.targets.map(itemLabel).join(", ") }) });
  if (row.billing_cycle) chips.push({ label: row.billing_cycle === "monthly" ? tl("Monthly billing only") : tl("Annual billing only") });
  if (row.allowed_emails) {
    chips.push({ label: tl("{{count}} email(s)", { count: row.allowed_emails.length }), title: row.allowed_emails.join("\n") });
  }
  if (row.signup_from && row.signup_to) {
    chips.push({ label: tl("Signed up {{from}} – {{to}}", { from: formatDate(row.signup_from), to: formatDate(row.signup_to) }) });
  } else if (row.signup_from) {
    chips.push({ label: tl("Signed up since {{date}}", { date: formatDate(row.signup_from) }) });
  } else if (row.signup_to) {
    chips.push({ label: tl("Signed up by {{date}}", { date: formatDate(row.signup_to) }) });
  }
  if (row.new_customers_only) chips.push({ label: tl("New customers only") });
  if (!row.allowed_emails && !row.signup_from && !row.signup_to && !row.new_customers_only) {
    chips.push({ label: tl("Everyone") });
  }
  return chips;
}

function DiscountRow({
  row,
  title,
  usage,
  itemLabel,
  busy,
  editing,
  onToggle,
  onEdit,
  onDelete,
}: {
  row: AdminPlanDiscount | AdminDiscountCode;
  title: ReactNode;
  usage?: string;
  itemLabel: (value: string) => string;
  busy: boolean;
  editing: boolean;
  onToggle: (next: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const status = statusOf(row);
  return (
    <div className={cn("flex items-start justify-between gap-4 px-5 py-4", editing && "bg-accent-bg")}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          {title}
          <span className={cn("rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold", status.tone)}>{status.label}</span>
        </div>
        <p className="mt-0.5 text-caption text-fg-muted">
          {formatAmount(row.discount_type, row.amount)}
          {usage && <span className="text-fg-subtle"> · {usage}</span>}
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {limitChips(row, itemLabel).map((chip) => (
            <span
              key={chip.label}
              title={chip.title}
              className="rounded-full border border-border px-2 py-0.5 text-[0.6875rem] text-fg-muted"
            >
              {chip.label}
            </span>
          ))}
        </div>
        <p className="mt-1.5 text-caption text-fg-subtle">{formatSchedule(row.starts_at, row.ends_at)}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Switch checked={row.active} disabled={busy} onChange={onToggle} />
        <button
          type="button"
          disabled={busy}
          onClick={onEdit}
          title={tl("Edit")}
          className="flex size-8 cursor-pointer items-center justify-center rounded-control text-fg-muted transition hover:bg-surface-raised hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
        >
          <PencilSimple size={16} />
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onDelete}
          title={tl("Delete")}
          className="flex size-8 cursor-pointer items-center justify-center rounded-control text-destructive transition hover:bg-destructive-bg disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Trash size={16} />
        </button>
      </div>
    </div>
  );
}

// --- sections ---------------------------------------------------------------------

function useDiscountEditor(initial: () => Draft) {
  const [draft, setDraft] = useState(initial);
  const [editingId, setEditingId] = useState<string | null>(null);
  const formRef = useRef<HTMLDivElement>(null);
  return {
    draft,
    set: (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch })),
    editingId,
    formRef,
    edit(id: string, next: Draft) {
      setEditingId(id);
      setDraft(next);
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    reset() {
      setEditingId(null);
      setDraft(initial());
    },
  };
}

function toastError(err: unknown) {
  pushToast({ kind: "error", title: tl("Couldn't save the discount"), description: friendlyError(err) });
}

function DiscountSection<Row extends AdminPlanDiscount | AdminDiscountCode>({
  kind,
  rows,
  items,
  empty,
  titleOf,
  usageOf,
  save,
  update,
  remove,
  onChanged,
}: {
  kind: "auto" | "code";
  rows: Row[];
  items: ItemOption[];
  empty: string;
  titleOf: (row: Row) => ReactNode;
  usageOf?: (row: Row) => string;
  save: (draft: Draft, id: string | null) => Promise<void>;
  update: (id: string, patch: { active: boolean }) => Promise<void>;
  remove: (id: string) => Promise<void>;
  onChanged: () => Promise<void>;
}) {
  const editor = useDiscountEditor(() => emptyDraft(items[0]?.value ?? ""));
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const itemLabel = (value: string) => items.find((i) => i.value === value)?.label ?? value;

  async function handleSave() {
    setSaving(true);
    try {
      await save(editor.draft, editor.editingId);
      pushToast({ kind: "success", title: editor.editingId ? tl("Discount saved") : tl("Discount created") });
      editor.reset();
      await onChanged();
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  }

  async function withRow(row: Row, action: () => Promise<void>, done?: string) {
    setBusyId(row.id);
    try {
      await action();
      if (done) pushToast({ kind: "success", title: done });
      await onChanged();
    } catch (err) {
      toastError(err);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div ref={editor.formRef} className="scroll-mt-6">
        <DiscountForm
          kind={kind}
          items={items}
          draft={editor.draft}
          set={editor.set}
          editing={editor.editingId !== null}
          saving={saving}
          onSave={handleSave}
          onCancel={editor.reset}
        />
      </div>

      {rows.length === 0 ? (
        <div className="rounded-card border border-border bg-surface p-6 text-body text-fg-subtle">{empty}</div>
      ) : (
        <div className="divide-y divide-border rounded-card border border-border bg-surface shadow-card">
          {rows.map((row) => (
            <DiscountRow
              key={row.id}
              row={row}
              title={titleOf(row)}
              usage={usageOf?.(row)}
              itemLabel={itemLabel}
              busy={busyId === row.id}
              editing={editor.editingId === row.id}
              onToggle={(active) => withRow(row, () => update(row.id, { active }))}
              onEdit={() => editor.edit(row.id, draftFrom(row))}
              onDelete={() =>
                withRow(row, async () => {
                  await remove(row.id);
                  if (editor.editingId === row.id) editor.reset();
                }, tl("Discount deleted"))
              }
            />
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

  if (loading) return <DiscountsSkeleton />;

  const items: ItemOption[] = [
    ...plans.map((p) => ({ value: `plan:${p.id}`, label: tl("{{name}} (plan)", { name: p.name }) })),
    ...packs.map((p) => ({ value: `pack:${p.id}`, label: tl("{{name}} (pack)", { name: p.label }) })),
  ];
  const itemLabel = (value: string) => items.find((i) => i.value === value)?.label ?? value;

  return (
    <div className="space-y-8">
      {error && <p className="text-caption text-destructive">{error}</p>}

      <div>
        <h2 className="text-h2 font-semibold text-fg">{tl("Plan & pack discounts")}</h2>
        <p className="mt-1 text-caption text-fg-muted">
          {tl("Lower the price of a plan or credit pack automatically, for everyone or only the people you pick.")}
        </p>
        <div className="mt-3">
          <DiscountSection
            kind="auto"
            rows={planDiscounts}
            items={items}
            empty={tl("No plan or pack discounts yet.")}
            titleOf={(d) => <p className="text-body font-medium text-fg">{itemLabel(`${d.target_type}:${d.target_id}`)}</p>}
            save={(draft, id) =>
              id ? updatePlanDiscount(id, toPlanDiscountInput(draft)) : createPlanDiscount(toPlanDiscountInput(draft))
            }
            update={updatePlanDiscount}
            remove={deletePlanDiscount}
            onChanged={handleChanged}
          />
        </div>
      </div>

      <div>
        <h2 className="text-h2 font-semibold text-fg">{tl("Discount codes")}</h2>
        <p className="mt-1 text-caption text-fg-muted">
          {tl("Codes users can type in at checkout. Redemptions are tracked automatically.")}</p>
        <div className="mt-3">
          <DiscountSection
            kind="code"
            rows={discountCodes}
            items={items}
            empty={tl("No discount codes yet.")}
            titleOf={(c) => <p className="font-mono text-body font-medium text-fg">{c.code}</p>}
            usageOf={(c) =>
              c.max_redemptions === null
                ? tl("{{redemption_count}} used (unlimited)", { redemption_count: c.redemption_count })
                : tl("{{used}} / {{max}} used", { used: c.redemption_count, max: c.max_redemptions })
            }
            save={(draft, id) =>
              id ? updateDiscountCode(id, toCodeInput(draft)) : createDiscountCode(toCodeInput(draft))
            }
            update={updateDiscountCode}
            remove={deleteDiscountCode}
            onChanged={handleChanged}
          />
        </div>
      </div>
    </div>
  );
}

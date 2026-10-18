import { useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  Check,
  CheckCircle,
  Coins,
  DownloadSimple,
  GraduationCap,
  MagicWand,
  Robot,
  ShieldWarning,
  Sparkle,
  type Icon,
} from "@phosphor-icons/react";
import { Button } from "../../components/ui/Button";
import { PLANS, CREDIT_PACKS } from "../../lib/mockData";
import { formatVND } from "@etymos/shared";
import { planDocLimit, planLabel, useAppStore } from "../../lib/store";
import { cn } from "@etymos/shared";
import { trackEvent } from "../../lib/analytics";
import { unlockDocument } from "../../lib/api";
import { t, tr } from "../../lib/i18n";
import {
  isBalanceReason,
  parsePaywallReason,
  requiredPlanFor,
  upgradePlansFor,
  type PaywallReason,
} from "../../lib/paywall";

/** Headline per reason. `null` is a direct visit with nothing to explain. */
const COPY: Record<PaywallReason | "generic", { icon: Icon; tone: "warning" | "brand"; title: string; description: string }> = {
  checks: {
    icon: ShieldWarning,
    tone: "warning",
    title: tr("You're out of checks for this month"),
    description: tr("Upgrade for more checks every month, or buy credits for one-off use."),
  },
  "standard-credits": {
    icon: Coins,
    tone: "warning",
    title: tr("You're out of Standard credits"),
    description: tr("Buy more credits, or subscribe to get checks every month."),
  },
  "premium-credits": {
    icon: Coins,
    tone: "warning",
    title: tr("You're out of Premium credits"),
    description: tr("Buy more credits, or subscribe to get checks every month."),
  },
  export: {
    icon: DownloadSimple,
    tone: "brand",
    title: tr("PDF export is a higher plan's feature"),
    description: tr("Upgrade to Standard or Premium to download your report as a PDF."),
  },
  semantic: {
    icon: GraduationCap,
    tone: "brand",
    title: tr("Semantic Detection is a higher plan's feature"),
    description: tr("Standard and Premium also catch paraphrased and reworded copying that word-for-word matching misses."),
  },
  "ai-detection": {
    icon: Robot,
    tone: "brand",
    title: tr("AI content detection is a higher plan's feature"),
    description: tr("See which paragraphs look AI-written. Included in Standard and Premium."),
  },
  rewrite: {
    icon: MagicWand,
    tone: "brand",
    title: tr("AI Rewrite is a higher plan's feature"),
    description: tr("Upgrade to Premium to rewrite matched passages in your own words."),
  },
  generic: {
    icon: Sparkle,
    tone: "brand",
    title: tr("Upgrade your plan"),
    description: tr("Get more checks each month, higher word limits and advanced detection."),
  },
};

export default function PaywallPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const plan = useAppStore((s) => s.plan);
  const checksUsed = useAppStore((s) => s.checksUsedThisPeriod);
  const standardCredits = useAppStore((s) => s.standardCredits);
  const premiumCredits = useAppStore((s) => s.premiumCredits);
  const pendingDocLabel = useAppStore((s) => s.pendingDocLabel);
  const clearPendingCheck = useAppStore((s) => s.clearPendingCheck);
  const selectCheckoutItem = useAppStore((s) => s.selectCheckoutItem);
  const applyDocumentUnlock = useAppStore((s) => s.applyDocumentUnlock);
  const pushToast = useAppStore((s) => s.pushToast);
  const [unlocking, setUnlocking] = useState<"student" | "professional" | null>(null);

  // Callers say why they sent the user here. A bare /paywall (old links, typed
  // URL) only claims "out of checks" when that is actually true.
  const reason: PaywallReason | null =
    parsePaywallReason(searchParams.get("reason")) ??
    (checksUsed >= planDocLimit(plan) && standardCredits + premiumCredits === 0 ? "checks" : null);
  const balanceReason = isBalanceReason(reason);
  const featureReason = requiredPlanFor(reason) !== null;

  useEffect(() => {
    trackEvent("paywall_viewed", { reason: reason ?? "generic" });
  }, [reason]);

  const offeredPlanIds = upgradePlansFor(plan, reason);
  const subscribePlans = PLANS.filter((p) => (offeredPlanIds as string[]).includes(p.id));
  // Credits buy one-off checks; they don't unlock a feature in the report the
  // user is looking at, so they're only offered for quota/credit shortfalls.
  const showCredits = balanceReason || reason === null;
  const alreadyIncluded = featureReason && subscribePlans.length === 0;

  // Opened from a report: a credit can unlock the feature for just that
  // document. A Standard credit gives it Standard's features, a Premium credit
  // Premium's — only credits at or above the tier the feature needs are offered.
  const docId = searchParams.get("doc");
  const unlockTier = featureReason && docId ? requiredPlanFor(reason) : null;
  const creditOptions = unlockTier
    ? [
        { tier: "student" as const, label: tr("Standard credit"), owned: standardCredits },
        { tier: "professional" as const, label: tr("Premium credit"), owned: premiumCredits },
      ].filter((o) => unlockTier === "student" || o.tier === "professional")
    : [];
  const usableCredits = creditOptions.filter((o) => o.owned > 0);
  const fittingPacks = CREDIT_PACKS.filter((p) => unlockTier !== "professional" || p.id === "pack-premium");

  const copy = COPY[reason ?? "generic"];
  const HeaderIcon = alreadyIncluded ? CheckCircle : copy.icon;

  function choosePlan(plan: (typeof subscribePlans)[number]) {
    selectCheckoutItem({ kind: "plan", plan: plan.id as "student" | "professional", billingCycle: "monthly" });
    navigate("/checkout");
  }

  function choosePack(packId: (typeof CREDIT_PACKS)[number]["id"]) {
    selectCheckoutItem({ kind: "pack", packId });
    navigate("/checkout");
  }

  function backToReport() {
    if (location.key !== "default") navigate(-1);
    else navigate(docId ? `/report/${docId}` : "/upload");
  }

  async function spendCredit(tier: "student" | "professional") {
    if (!docId || unlocking) return;
    setUnlocking(tier);
    try {
      const result = await unlockDocument(docId, tier);
      applyDocumentUnlock(docId, {
        unlockedTier: result.unlocked_tier,
        standardCredits: result.standard_credits,
        premiumCredits: result.premium_credits,
      });
      trackEvent("document_unlocked", { tier, reason, spent: result.status === "ok" });
      pushToast({
        kind: "success",
        title: t("Document upgraded"),
        description: t("{{plan}} features are now unlocked for this document.", { plan: planLabel(result.unlocked_tier) }),
      });
      backToReport();
    } catch (err) {
      pushToast({
        kind: "error",
        title: t("Couldn't unlock this document"),
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setUnlocking(null);
    }
  }

  function maybeLater() {
    if (balanceReason) {
      clearPendingCheck();
      navigate("/upload");
      return;
    }
    // Feature paywalls are opened from inside a report — send the user back to it.
    backToReport();
  }

  return (
    <div className="studio-page mx-auto max-w-4xl px-5 py-14 sm:px-8">
      <div className="text-center">
        <div
          className={cn(
            "mx-auto flex size-14 items-center justify-center rounded-full",
            alreadyIncluded
              ? "bg-brand-100 text-brand-600"
              : copy.tone === "warning"
                ? "bg-severity-moderate-bg text-severity-moderate"
                : "bg-brand-100 text-brand-600",
          )}
        >
          <HeaderIcon size={28} weight="fill" />
        </div>
        <h1 className="mt-5 text-h1 font-bold tracking-tight text-navy-900">
          {alreadyIncluded ? t("Your plan already includes this") : t(copy.title)}
        </h1>
        <p className="mx-auto mt-3 max-w-md text-body-lg text-ink-600">
          {alreadyIncluded
            ? t("You're on {{plan}}. Go back and try again — if it's still locked, refresh the page.", { plan: planLabel(plan) })
            : balanceReason && pendingDocLabel
              ? <>{t("We'll pick up right where you left off with")}{" "}<span className="font-semibold text-ink-800">{pendingDocLabel}</span>{" "}{t("as soon as you're ready.")}</>
              : t(copy.description)}
        </p>
      </div>

      {!alreadyIncluded && (subscribePlans.length > 0 || showCredits || unlockTier) && (
        <div
          className={cn(
            "mt-10 grid grid-cols-1 gap-6",
            subscribePlans.length > 0 && (showCredits || unlockTier) ? "lg:grid-cols-2" : "mx-auto max-w-md",
          )}
        >
          {subscribePlans.length > 0 && (
            <div className="rounded-[var(--radius-card-lg)] border border-line bg-white p-7">
              <p className="text-xs font-bold uppercase tracking-wide text-brand-600">
                {featureReason ? t("Unlock it with") : t("Best value")}
              </p>
              <h2 className="mt-1.5 text-lg font-bold text-navy-900">{t("Subscribe")}</h2>
              <p className="mt-1 text-sm text-ink-500">{t("More checks every month for regular use.")}</p>

              <div className="mt-5 flex flex-col gap-3">
                {subscribePlans.map((plan) => (
                  <div
                    key={plan.id}
                    className={cn(
                      "flex items-center justify-between gap-4 rounded-[var(--radius-card)] border p-4",
                      plan.mostPopular ? "border-brand-400 bg-brand-100/30" : "border-line",
                    )}
                  >
                    <div>
                      <p className="flex items-center gap-1.5 text-sm font-bold text-navy-900">
                        {t(plan.name)}
                        {plan.mostPopular && <Sparkle size={13} weight="fill" className="text-brand-500" />}
                      </p>
                      <p className="text-xs text-ink-500">{formatVND(plan.priceMonthly)}{t("/mo")}</p>
                    </div>
                    <Button
                      size="sm"
                      variant={plan.mostPopular || subscribePlans.length === 1 ? "primary" : "outline"}
                      onClick={() => choosePlan(plan)}
                    >
                      {t("Choose")}
                    </Button>
                  </div>
                ))}
              </div>

              <ul className="mt-5 flex flex-col gap-2">
                {[tr("More documents per month"), tr("Higher word limits"), tr("Priority support")].map((f) => (
                  <li key={f} className="flex items-center gap-2 text-xs text-ink-600">
                    <Check size={14} weight="bold" className="text-brand-500" />
                    {t(f)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {unlockTier && (
            <div className="rounded-[var(--radius-card-lg)] border border-line bg-white p-7">
              <p className="text-xs font-bold uppercase tracking-wide text-ink-500">{t("Pay as you go")}</p>
              <h2 className="mt-1.5 text-lg font-bold text-navy-900">{t("Use a credit on this document")}</h2>
              <p className="mt-1 text-sm text-ink-500">
                {usableCredits.length > 0
                  ? t("Unlocks it for this document only, no subscription.")
                  : t("You have no fitting credits. Buy one, then come back to use it on this document.")}
              </p>

              <div className="mt-5 flex flex-col gap-3">
                {usableCredits.length > 0
                  ? usableCredits.map((option) => (
                      <div
                        key={option.tier}
                        className="flex items-center justify-between gap-4 rounded-[var(--radius-card)] border border-line p-4"
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex size-9 items-center justify-center rounded-full bg-surface-muted text-ink-500">
                            <Coins size={17} weight="fill" />
                          </div>
                          <div>
                            <p className="text-sm font-bold text-navy-900">{t(option.label)}</p>
                            <p className="text-xs text-ink-500">
                              {t("Unlocks {{plan}} features · you have {{count}}", { plan: planLabel(option.tier), count: option.owned })}
                            </p>
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant={usableCredits.length === 1 || option.tier === unlockTier ? "primary" : "outline"}
                          loading={unlocking === option.tier}
                          disabled={unlocking !== null && unlocking !== option.tier}
                          onClick={() => void spendCredit(option.tier)}
                        >
                          {t("Use 1")}
                        </Button>
                      </div>
                    ))
                  : fittingPacks.map((pack) => (
                      <div
                        key={pack.id}
                        className="flex items-center justify-between gap-4 rounded-[var(--radius-card)] border border-line p-4"
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex size-9 items-center justify-center rounded-full bg-surface-muted text-ink-500">
                            <Coins size={17} weight="fill" />
                          </div>
                          <div>
                            <p className="text-sm font-bold text-navy-900">{t(pack.label)}</p>
                            <p className="text-xs text-ink-500">{formatVND(pack.price)} · {t(pack.description)}</p>
                          </div>
                        </div>
                        <Button size="sm" variant="outline" onClick={() => choosePack(pack.id)}>
                          {t("Buy")}
                        </Button>
                      </div>
                    ))}
              </div>
            </div>
          )}

          {showCredits && (
            <div className="rounded-[var(--radius-card-lg)] border border-line bg-white p-7">
              <p className="text-xs font-bold uppercase tracking-wide text-ink-500">{t("Pay as you go")}</p>
              <h2 className="mt-1.5 text-lg font-bold text-navy-900">{t("Buy credits")}</h2>
              <p className="mt-1 text-sm text-ink-500">{t("For one-off checks, no subscription.")}</p>

              <div className="mt-5 flex flex-col gap-3">
                {CREDIT_PACKS.map((pack) => (
                  <div
                    key={pack.id}
                    className="flex items-center justify-between gap-4 rounded-[var(--radius-card)] border border-line p-4"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex size-9 items-center justify-center rounded-full bg-surface-muted text-ink-500">
                        <Coins size={17} weight="fill" />
                      </div>
                      <div>
                        <p className="text-sm font-bold text-navy-900">{t(pack.label)}</p>
                        <p className="text-xs text-ink-500">{formatVND(pack.price)} · {t(pack.description)}</p>
                      </div>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => choosePack(pack.id)}>
                      {t("Buy")}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-8 text-center">
        <button onClick={maybeLater} className="text-sm font-medium text-ink-500 hover:text-ink-700 hover:underline">
          {alreadyIncluded ? t("Go back") : t("Maybe later")}</button>
      </div>
    </div>
  );
}

import { tr } from "../../../lib/i18n";
import type { Policy } from "./types";

export const PLANS: Policy = {
  slug: "plans",
  path: "/plans-and-credits",
  title: tr("Plans & credits"),
  summary: tr("How plans, credits and checks are counted"),
  intro: [
    tr("This page explains the ways to run checks on Etymos, what uses up a check, and what happens when a plan ends. Current prices and the features of each plan are on the Pricing page."),
  ],
  sections: [
    {
      title: tr("1. Ways to run checks"),
      blocks: [
        {
          kind: "list",
          items: [
            tr("Free plan: a small monthly allowance of checks with basic features. No payment needed."),
            tr("Standard plan: for students, after student verification. Includes a monthly allowance of checks and the full set of detection features."),
            tr("Premium plan: for researchers and professionals, with a larger allowance and the longest history."),
            tr("Credit packs: pay per check, without a subscription. Standard credits run a check with Standard features, Premium credits with Premium features."),
          ],
        },
      ],
    },
    {
      title: tr("2. What counts as a check"),
      blocks: [
        {
          kind: "list",
          items: [
            tr("One document analysed to the end is one check. Before it starts, you choose whether it uses your plan's allowance or a credit."),
            tr("A check is deducted only when it completes successfully. Checks that fail are not charged."),
            tr("After editing a document in its report, you can re-check it. Small edits get a number of free re-checks, depending on your plan; the report tells you before you start whether a re-check is free or uses a check."),
          ],
        },
      ],
    },
    {
      title: tr("3. Monthly allowance"),
      blocks: [
        { kind: "p", text: tr("Plans include a number of checks for each 30-day period. The count resets at the start of each period, and unused checks don't carry over.") },
      ],
    },
    {
      title: tr("4. Credits"),
      blocks: [
        {
          kind: "list",
          items: [
            tr("Bought credits never expire."),
            tr("Credits are not money: they can't be exchanged for cash (except under the Refund Policy) or moved to another account."),
            tr("Credits are only sold by Etymos. Credits bought from anyone else are not valid."),
          ],
        },
      ],
    },
    {
      title: tr("5. Plan terms"),
      blocks: [
        {
          kind: "list",
          items: [
            tr("Plans are prepaid for one month or one year, counted in calendar months from the day the payment is confirmed."),
            tr("Plans don't renew automatically. Your account page shows a reminder in the last 7 days of a plan."),
            tr("Buying the same plan again adds a new term after the current end date, so you don't lose any time."),
            tr("Buying a different plan replaces the current one from that day. The remaining time on the old plan is not carried over or refunded, and checkout warns you before you pay."),
          ],
        },
      ],
    },
    {
      title: tr("6. When a plan ends"),
      blocks: [
        { kind: "p", text: tr("Your account moves to the Free plan and its limits apply. Credits you bought stay in your account. Your existing reports remain available for the Free plan's history period, and buying a plan again restores the longer history period.") },
      ],
    },
    {
      title: tr("7. History retention"),
      blocks: [
        {
          kind: "list",
          items: [
            tr("Free: 7 days."),
            tr("Standard: 9 months."),
            tr("Premium: 12 months."),
          ],
        },
        { kind: "p", text: tr("After that, reports and their documents are deleted. If your plan includes PDF export, download any report you want to keep before then.") },
      ],
    },
  ],
};

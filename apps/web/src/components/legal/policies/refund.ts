import { tr } from "../../../lib/i18n";
import type { Policy } from "./types";

export const REFUND: Policy = {
  slug: "refund",
  path: "/refund-policy",
  title: tr("Refund Policy"),
  summary: tr("When you can get a check or your money back"),
  intro: [
    tr("This policy sets out exactly when Etymos gives back a check, when it refunds money to your bank account, and when it doesn't."),
  ],
  sections: [
    {
      title: tr("Case 1: The check is not charged"),
      blocks: [
        { kind: "p", text: tr("A check uses your allowance or a credit only when it completes successfully. If a check fails because of a problem on our side, nothing is deducted and you can simply run it again.") },
        { kind: "p", text: tr("If a completed report is clearly broken because of a fault on our side (for example, the text couldn't be read), contact us and we'll return the check.") },
      ],
    },
    {
      title: tr("Case 2: Money back to your bank account"),
      blocks: [
        {
          kind: "list",
          items: [
            tr("Within 7 days of paying, if you haven't used what you bought: no checks run on the plan, and none of the pack's credits used. You get the full amount back."),
            tr("At any time, for a duplicate payment, an overpayment, or a transfer we couldn't match to an order."),
            tr("If we stop offering a plan you have paid for, or close your account without a breach on your part: we refund the unused part of the plan's term and any unused credits."),
          ],
        },
      ],
    },
    {
      title: tr("Case 3: No refund"),
      blocks: [
        {
          kind: "list",
          items: [
            tr("Plans or credit packs that have been used, or were bought more than 7 days ago (except for the cases above)."),
            tr("Remaining time on a plan that you replaced by buying a different plan."),
            tr("Disagreeing with a similarity score or AI-content estimate. Results are estimates; see the Terms of Service."),
            tr("Free checks, or credits and plan time given through promotions or by our team."),
            tr("Accounts suspended or closed for breaking the Terms, including false student verification."),
          ],
        },
      ],
    },
    {
      title: tr("How to ask for a refund"),
      blocks: [
        {
          kind: "steps",
          items: [
            { title: tr("Contact us"), text: tr("Write to {{email}} or open a support request, from your account email.") },
            { title: tr("Give the details"), text: tr("Include the order code and, for transfers that didn't match an order, a screenshot of the receipt.") },
            { title: tr("We review"), text: tr("We reply within 3 business days with our decision.") },
            { title: tr("You're refunded"), text: tr("Approved refunds go back to the bank account the payment came from, usually within 7 business days. The plan or credits are removed when the refund is made.") },
          ],
        },
        { kind: "note", text: tr("This policy doesn't limit any rights you have under Vietnamese consumer protection law.") },
      ],
    },
  ],
};

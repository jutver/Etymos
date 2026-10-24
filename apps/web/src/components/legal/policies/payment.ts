import { tr } from "../../../lib/i18n";
import type { Policy } from "./types";

export const PAYMENT: Policy = {
  slug: "payment",
  path: "/payment-policy",
  title: tr("Payment Policy"),
  summary: tr("How to pay and when your purchase is added"),
  intro: [
    tr("This policy explains how to pay for plans and credit packs on Etymos, how long it takes, and what to do if something goes wrong."),
  ],
  sections: [
    {
      title: tr("1. Prices"),
      blocks: [
        {
          kind: "list",
          items: [
            tr("Prices are in Vietnamese đồng (VND) and are shown on the Pricing page and at checkout."),
            tr("The amount shown at checkout, after any discount, is the amount you pay. There are no hidden fees."),
            tr("We may change prices. A change never affects a plan or pack you have already paid for."),
          ],
        },
      ],
    },
    {
      title: tr("2. How to pay"),
      blocks: [
        { kind: "p", text: tr("Etymos accepts bank transfers through VietQR. You can pay from any Vietnamese banking app, or with MoMo or ZaloPay.") },
        {
          kind: "steps",
          items: [
            { title: tr("Choose a plan"), text: tr("Pick a plan or credit pack on the Pricing page.") },
            { title: tr("Check out"), text: tr("Review the order and apply a discount code if you have one.") },
            { title: tr("Scan"), text: tr("Scan the QR code with your banking app. Keep the amount and transfer content exactly as filled in.") },
            { title: tr("Plan added"), text: tr("Your plan or credits are added automatically once the transfer arrives, and we email you a confirmation.") },
          ],
        },
        { kind: "note", text: tr("Each order has its own QR code and is valid for the time shown at checkout. Always pay through the QR code of your own, current order: changing the amount or the transfer content stops us from matching the payment automatically.") },
        { kind: "p", text: tr("Etymos never sees your card details or bank login. Payments are confirmed through SePay, which reads incoming transfers to our bank account.") },
      ],
    },
    {
      title: tr("3. Processing time"),
      blocks: [
        {
          kind: "list",
          items: [
            tr("Usually within a minute of the transfer."),
            tr("Some interbank transfers can take longer, especially outside banking hours."),
          ],
        },
        { kind: "note", text: tr("If your plan or credits haven't appeared 30 minutes after paying, send us your order code and a screenshot of the transfer receipt at {{email}} or through a support request. We'll match it by hand.") },
      ],
    },
    {
      title: tr("4. Discount codes"),
      blocks: [
        { kind: "p", text: tr("Discount codes may have their own conditions, such as dates, eligible plans, a usage limit, or being for new customers only. They are checked at checkout, can't be exchanged for cash, and can't be applied to an order after it is paid.") },
      ],
    },
    {
      title: tr("5. Payment problems"),
      blocks: [
        {
          kind: "list",
          items: [
            tr("Paid twice, or paid an order that had already expired: contact us and we'll add it or refund it."),
            tr("Transferred the wrong amount: the order isn't activated automatically. Contact us and we'll either complete the order or refund the transfer."),
            tr("Refunds are handled as described in the Refund Policy."),
          ],
        },
      ],
    },
    {
      title: tr("6. Payment history"),
      blocks: [
        { kind: "p", text: tr("You can see every order and its status under Account > Payments.") },
      ],
    },
  ],
};

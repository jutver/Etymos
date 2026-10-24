import { tr } from "../../../lib/i18n";
import type { Policy } from "./types";

export const COMPLAINT: Policy = {
  slug: "complaint",
  path: "/complaint-policy",
  title: tr("Complaint Policy"),
  summary: tr("How we handle complaints and disputes"),
  intro: [
    tr("If something goes wrong with Etymos, we want to hear about it and put it right. This policy explains how to complain, how we handle it, and how long it takes. We always try to settle disagreements by talking them through first."),
  ],
  sections: [
    {
      title: tr("1. Who can complain and how"),
      blocks: [
        { kind: "p", text: tr("The account holder, or someone legally acting for them, can complain through any of these channels:") },
        {
          kind: "list",
          items: [
            tr("A support request in your account (Account > Support)."),
            tr("The Contact page, if you can't sign in."),
            tr("Email: {{email}}."),
          ],
        },
        { kind: "p", text: tr("Please include what happened, when, and any order code, report or screenshot that helps. For payment problems, it helps to contact us within 30 days, while bank records are easy to check.") },
      ],
    },
    {
      title: tr("2. How we handle a complaint"),
      blocks: [
        {
          kind: "steps",
          items: [
            { title: tr("We receive it"), text: tr("We confirm we've received your complaint, with a request number, within 1 business day.") },
            { title: tr("We check"), text: tr("We look into the account, report or payment involved, and may ask you for more information.") },
            { title: tr("We reply"), text: tr("We tell you what we found and what we'll do, by email and in the support conversation.") },
            { title: tr("Second review"), text: tr("If you're not satisfied, reply and we'll review the complaint again from the start.") },
            { title: tr("Closing"), text: tr("Once we agree on a solution, we carry it out and close the request.") },
          ],
        },
        { kind: "p", text: tr("If we still can't agree after the second review, you can take the matter to a consumer protection organisation, the competent state authority, or a court, as Vietnamese law allows.") },
      ],
    },
    {
      title: tr("3. How long it takes"),
      blocks: [
        {
          kind: "list",
          items: [
            tr("Most complaints: within 7 business days of receiving all the information we need."),
            tr("Complaints that involve a bank or another third party: up to 30 days. We'll keep you updated along the way."),
          ],
        },
      ],
    },
    {
      title: tr("4. Questions about a report"),
      blocks: [
        { kind: "p", text: tr("If you think a report has flagged something wrongly, tell us which report and which passage. We'll explain how the result was produced and fix any fault in Etymos. We can't change a score by hand, because results must come from the same process for everyone.") },
      ],
    },
    {
      title: tr("5. Copyright notices"),
      blocks: [
        { kind: "p", text: tr("Reports show short extracts of public sources next to the matching text. If you hold the rights to a work and believe Etymos uses it improperly, email {{email}} with the subject \"[COPYRIGHT] name of the work\", including:") },
        {
          kind: "list",
          items: [
            tr("Your name, contact details, and whether you are the rights holder or acting for them."),
            tr("The work concerned and proof that you hold the rights."),
            tr("Where it appears on Etymos and what you believe is wrong."),
            tr("A statement that the information is accurate."),
          ],
        },
        { kind: "p", text: tr("We confirm receipt within 1 business day and act on valid notices within 5 business days.") },
      ],
    },
  ],
};

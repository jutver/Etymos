import { tr } from "../../../lib/i18n";
import type { Policy } from "./types";

export const TERMS: Policy = {
  slug: "terms",
  path: "/terms",
  title: tr("Terms of Service"),
  summary: tr("The rules for using Etymos"),
  intro: [
    tr("These Terms of Service (the \"Terms\") set out the rights and obligations between you and Etymos when you use the plagiarism and AI-content checking service at etymos.site, including its website, web app and API (the \"Service\")."),
    tr("The Privacy Policy, Payment Policy, Refund Policy, Complaint Policy and the Plans & credits page are part of these Terms. By creating an account or using the Service, you agree to all of them."),
  ],
  sections: [
    {
      title: tr("1. Definitions"),
      blocks: [
        {
          kind: "list",
          items: [
            tr("Service: the Etymos website, web app, API and everything they provide."),
            tr("You, the user: the person who creates an account or uses the Service."),
            tr("Document: any file or text you upload, paste or edit in the Service."),
            tr("Check: one completed analysis of one document, which produces a report."),
            tr("Report: the result of a check: similarity score, matched sources, AI-content estimate and explanations."),
            tr("Plan and credits: the paid ways to run checks, described on the Plans & credits page."),
          ],
        },
      ],
    },
    {
      title: tr("2. Accepting these Terms"),
      blocks: [
        { kind: "p", text: tr("You must be at least 16 years old to use Etymos. If you are under 18, you may use it only with the agreement of a parent or legal guardian.") },
        { kind: "p", text: tr("We ask every signed-in user to accept the current Terms before using the app, and again whenever they change. We keep a record of the version you accepted and when. If you don't agree with any part of the Terms, please don't use the Service.") },
      ],
    },
    {
      title: tr("3. Your responsibilities"),
      blocks: [
        { kind: "h3", text: tr("3.1. Lawful and honest use") },
        { kind: "p", text: tr("You agree not to use Etymos to:") },
        {
          kind: "list",
          items: [
            tr("Pass off someone else's work as your own, or help others do so."),
            tr("Upload content that is illegal, infringes copyright or other rights, or contains malware."),
            tr("Scrape, copy or resell the Service or its reports, or access it with bots or scripts other than the features we provide."),
            tr("Break, overload or get around the Service's security, usage limits or payment checks, or reverse engineer it."),
            tr("Abuse discount codes, create several accounts to get extra free checks, or impersonate another person."),
          ],
        },
        { kind: "note", text: tr("You are responsible for the documents you upload and for what you do with your reports. We don't review the content of your documents, except when needed to answer your support request or a lawful request from the authorities.") },
        { kind: "h3", text: tr("3.2. Account security") },
        { kind: "p", text: tr("Give accurate information when you sign up and keep your password safe. One account is for one person: don't share your login or sell access to it. Everything done with your account is treated as done by you, so tell us at {{email}} straight away if you think someone else has used it.") },
        { kind: "h3", text: tr("3.3. Student verification") },
        { kind: "p", text: tr("The Standard plan is for students. To buy it, you upload a student ID or an enrollment document, which we review by hand. It must be genuine and your own. If a verification turns out to be false, we may cancel the plan without a refund and suspend the account.") },
        { kind: "h3", text: tr("3.4. Using the results responsibly") },
        { kind: "p", text: tr("Similarity scores, matched sources and AI-content estimates are automated signals to help you review your writing. They can miss copied text, flag original text, or misjudge whether text was written by AI. They are not proof of plagiarism or misconduct and should not be the only basis for an academic or disciplinary decision.") },
        { kind: "p", text: tr("You remain responsible for your own work: citing your sources, checking suggestions from the AI Rewrite Assistant, and following the rules of your school, journal or employer.") },
      ],
    },
    {
      title: tr("4. Your documents"),
      blocks: [
        { kind: "p", text: tr("You keep all rights to your documents. You allow us to store, copy and process them only as far as needed to run your checks, show you your reports and support you. We don't show your documents to other users, add them to a public database, compare other people's checks against them, or sell them.") },
        { kind: "p", text: tr("Some features send parts of your text to the services that power them. The Privacy Policy lists those services and how long we keep your documents.") },
      ],
    },
    {
      title: tr("5. Our responsibilities"),
      blocks: [
        { kind: "h3", text: tr("5.1. Providing the Service") },
        { kind: "p", text: tr("We provide the Service as described on the site and work to keep it available and accurate. Etymos is in closed beta: new accounts join a waitlist, features may change, and there may be downtime for maintenance or unexpected faults.") },
        { kind: "h3", text: tr("5.2. Protecting your information") },
        { kind: "p", text: tr("We protect your personal data and documents as set out in the Privacy Policy, and disclose them only with your consent or when the law requires it.") },
        { kind: "h3", text: tr("5.3. Support") },
        { kind: "p", text: tr("You can reach us through a support request in your account, the Contact page, or {{email}}. We usually reply within one business day.") },
        { kind: "h3", text: tr("5.4. What we are not responsible for") },
        {
          kind: "list",
          items: [
            tr("Decisions that schools, lecturers, journals or employers make based on a report."),
            tr("Problems caused by your device, network or browser, or by files that are damaged or protected."),
            tr("The content of third-party websites and papers shown as matched sources."),
            tr("Unauthorised access that happens despite reasonable security measures on our side."),
          ],
        },
      ],
    },
    {
      title: tr("6. Plans, credits and payment"),
      blocks: [
        { kind: "p", text: tr("Paid plans are prepaid for a month or a year and don't renew automatically. Credits never expire, and a check that fails on our side is not charged. How plans and credits work is explained on the Plans & credits page; how to pay, and when you can get your money back, are in the Payment Policy and the Refund Policy.") },
      ],
    },
    {
      title: tr("7. Suspension and termination"),
      blocks: [
        { kind: "h3", text: tr("7.1. Suspension") },
        {
          kind: "list",
          items: [
            tr("Serious breaches (fraud, attacks on the Service, illegal content, false student verification): we may suspend the account immediately."),
            tr("Other breaches: we'll warn you first when we reasonably can."),
          ],
        },
        { kind: "h3", text: tr("7.2. Closing your account") },
        { kind: "p", text: tr("You can stop using Etymos at any time, and ask us to close your account and delete its data at {{email}}. What is deleted, and what we must keep, is set out in the Privacy Policy.") },
        { kind: "h3", text: tr("7.3. Closing by us") },
        { kind: "p", text: tr("If we close your account without a breach on your part, or stop offering a plan you have paid for, we refund the unused part as described in the Refund Policy.") },
      ],
    },
    {
      title: tr("8. Intellectual property"),
      blocks: [
        { kind: "p", text: tr("The Etymos name, logo, website, software and report design belong to us. You may download and share your own reports, but you may not copy, modify or redistribute the Service itself.") },
      ],
    },
    {
      title: tr("9. Limitation of liability"),
      blocks: [
        { kind: "p", text: tr("To the extent Vietnamese law allows, the Service is provided \"as is\". We are not liable for indirect or consequential losses, such as lost grades, opportunities, income or data. Our total liability for any claim is limited to the amount you paid us in the 3 months before the claim. Nothing here limits liability that the law does not allow to be limited.") },
      ],
    },
    {
      title: tr("10. Force majeure"),
      blocks: [
        { kind: "p", text: tr("Neither side is responsible for failing to meet its obligations while prevented by events beyond reasonable control, such as natural disasters, power or internet outages, or failures of the infrastructure providers we rely on.") },
      ],
    },
    {
      title: tr("11. Changes to the Service and these Terms"),
      blocks: [
        { kind: "p", text: tr("We may add, change or remove features, adjust plans and limits, or update these Terms and the policies that are part of them. Changes don't affect plans you have already paid for. When the Terms change, the date at the top changes and we ask you to accept the new version the next time you use the app.") },
      ],
    },
    {
      title: tr("12. Governing law and disputes"),
      blocks: [
        { kind: "p", text: tr("These Terms are governed by the laws of the Socialist Republic of Vietnam. If a dispute arises, please raise it with us first through the Complaint Policy so we can try to resolve it together. If we can't, it will be settled by a competent court of Vietnam. If the English and Vietnamese versions differ, the Vietnamese version prevails.") },
      ],
    },
  ],
};

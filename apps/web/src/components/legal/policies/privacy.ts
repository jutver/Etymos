import { tr } from "../../../lib/i18n";
import type { Policy } from "./types";

export const PRIVACY: Policy = {
  slug: "privacy",
  path: "/privacy-policy",
  title: tr("Privacy Policy"),
  summary: tr("What data we collect and how we protect it"),
  intro: [
    tr("This policy explains what personal data Etymos collects, why, who it is shared with, how long it is kept, and the rights you have over it under Vietnam's personal data protection law."),
  ],
  sections: [
    {
      title: tr("1. Who is responsible for your data"),
      blocks: [
        { kind: "p", text: tr("Your personal data is controlled and processed by {{owner}}, who operates Etymos, at {{address}}. For any question about your data, write to {{email}}.") },
      ],
    },
    {
      title: tr("2. What we collect"),
      blocks: [
        { kind: "h3", text: tr("2.1. Data you give us") },
        {
          kind: "list",
          items: [
            tr("Account details: email address and display name, plus your name and profile photo if you sign in with Google. Passwords are handled by our sign-in provider and we never see them."),
            tr("Documents: the files and text you check, the reports we produce, and the versions you save while editing."),
            tr("Student verification: the photo of your student ID or enrollment document. It may show details such as your name, school, student number and photo."),
            tr("Payments: your orders and the transfer details our bank sends us (amount, time, transfer content and reference)."),
            tr("Support: the messages and attachments you send us."),
          ],
        },
        { kind: "h3", text: tr("2.2. Data collected automatically") },
        {
          kind: "list",
          items: [
            tr("Usage events, such as which pages you open and which features you use. These never include document content."),
            tr("Technical data such as IP address and browser type, used for security and to limit abuse."),
            tr("Settings stored in your browser, such as your language and sign-in session. We don't use advertising or tracking cookies."),
          ],
        },
        { kind: "h3", text: tr("2.3. What we don't collect") },
        { kind: "p", text: tr("We don't ask for your national ID number, home address or phone number, and we never receive your card number or bank login.") },
      ],
    },
    {
      title: tr("3. How we use your data"),
      blocks: [
        {
          kind: "list",
          items: [
            tr("To run checks, build reports and keep your document history."),
            tr("To manage your account, the waitlist, student verification and your plan."),
            tr("To confirm payments and handle refunds."),
            tr("To answer support requests and send service emails, such as payment confirmations and important notices."),
            tr("To keep the Service secure and prevent abuse."),
            tr("To improve Etymos using usage statistics that don't identify you."),
          ],
        },
        { kind: "note", text: tr("We don't sell your data, use it for advertising, or use your documents to train our own models.") },
      ],
    },
    {
      title: tr("4. Who your data is shared with"),
      blocks: [
        { kind: "p", text: tr("We share data only with the services that help us run Etymos, and only what each one needs:") },
        {
          kind: "list",
          items: [
            tr("Supabase: database, sign-in and file storage for your account, documents and reports."),
            tr("Google (Gemini API): parts of your text, for match explanations, AI-content analysis and the AI Rewrite Assistant."),
            tr("Search services (DuckDuckGo, OpenAlex, Semantic Scholar, arXiv): short extracts or keywords from your document, sent as search queries to find possible sources. Your whole document is not sent."),
            tr("SePay and our bank: to confirm your bank transfers."),
            tr("Our email provider (iNET OneMail): to send and receive service and support emails."),
            tr("Competent authorities: when the law requires it."),
          ],
        },
        { kind: "p", text: tr("Some of these providers store or process data on servers outside Vietnam. By using Etymos you agree to this transfer, which we limit to what is needed to provide the Service.") },
      ],
    },
    {
      title: tr("5. How long we keep your data"),
      blocks: [
        {
          kind: "list",
          items: [
            tr("Account details: for as long as you have an account."),
            tr("Documents and reports: for the history period of your plan (see Plans & credits), then deleted. You can move them to Trash and delete them sooner."),
            tr("Student verification images: for as long as needed to review your request and keep a record of the decision."),
            tr("Payment records: for as long as accounting and tax law requires, even after the account is closed."),
            tr("Support conversations: for as long as needed to resolve the request and handle any follow-up."),
          ],
        },
        { kind: "p", text: tr("When you close your account, we delete its documents, reports and files. Copies may remain in backups for a short time before they are overwritten.") },
      ],
    },
    {
      title: tr("6. Your rights"),
      blocks: [
        { kind: "p", text: tr("Under Vietnam's personal data protection law, you have the right to:") },
        {
          kind: "list",
          items: [
            tr("Know how your data is processed, and see or get a copy of it."),
            tr("Correct data that is wrong."),
            tr("Have your data deleted, or its processing restricted."),
            tr("Withdraw your consent. Some features may then stop working, and withdrawal doesn't affect processing done before it."),
            tr("Complain to us or to the competent authority."),
          ],
        },
        { kind: "p", text: tr("To use any of these rights, write to {{email}} from your account email. You can also edit your name and profile in your account settings. We respond within the time limits set by law.") },
      ],
    },
    {
      title: tr("7. How we protect your data"),
      blocks: [
        {
          kind: "list",
          items: [
            tr("All connections use encryption (HTTPS)."),
            tr("Database rules make sure each account can only read its own documents and reports."),
            tr("Files are opened through short-lived private links, not public addresses."),
            tr("Only a small number of administrators can access account data, and their actions are logged."),
          ],
        },
        { kind: "p", text: tr("If a data breach affects you, we'll notify you and the competent authority as the law requires.") },
      ],
    },
    {
      title: tr("8. Children"),
      blocks: [
        { kind: "p", text: tr("Etymos is not meant for children under 16, and we don't knowingly collect their data. If you think a child has created an account, contact us and we'll delete it.") },
      ],
    },
    {
      title: tr("9. Privacy complaints"),
      blocks: [
        { kind: "p", text: tr("If you think your data has been used in a way this policy doesn't allow, contact us at {{email}}. We'll investigate and reply as described in the Complaint Policy. You can also contact the competent state authority for personal data protection.") },
      ],
    },
  ],
};

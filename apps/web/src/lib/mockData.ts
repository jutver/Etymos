import type { CreditPack, PaymentMethod, PlanDefinition } from "@etymos/shared";
import { tr } from "./i18n";

export const PLANS: PlanDefinition[] = [
  {
    id: "free",
    name: tr("Free"),
    tagline: tr("Get started and try a real check"),
    priceMonthly: 0,
    priceAnnual: 0,
    audience: tr("New users, occasional checks"),
    features: [
      tr("2 documents / month, up to 3,000 words each"),
      tr("Traditional plagiarism detection"),
      tr("Similarity score & matched sources"),
      tr("Basic report"),
      tr("7-day history"),
    ],
  },
  {
    id: "student",
    name: tr("Standard"),
    tagline: tr("For students, grad and PhD researchers"),
    priceMonthly: 69000,
    priceAnnual: 490000,
    audience: tr("Students, grad & PhD researchers"),
    mostPopular: true,
    requiresVerification: true,
    features: [
      tr("10 documents / month, up to 10,000 words each"),
      tr("Semantic plagiarism detection"),
      tr("Explainable AI, in plain language"),
      tr("Multi-language checking"),
      tr("PDF export"),
      tr("9-month history"),
      tr("Priority support"),
    ],
  },
  {
    id: "professional",
    name: tr("Premium"),
    tagline: tr("For lecturers, researchers & agencies"),
    priceMonthly: 199000,
    priceAnnual: 1790000,
    audience: tr("Lecturers, researchers, content & SEO teams"),
    features: [
      tr("50 documents / month, up to 25,000 words each"),
      tr("Everything in Standard"),
      tr("AI Rewrite Assistant"),
      tr("Multi-project management"),
      tr("In-depth advanced report export"),
      tr("Draft-over-time originality tracking"),
      tr("12-month history"),
      tr("24/7 priority support"),
    ],
  },
];

export const CREDIT_PACKS: CreditPack[] = [
  {
    id: "pack-standard",
    label: tr("Standard check"),
    description: tr("Everything in Standard, pay-per-use"),
    checks: 1,
    price: 19000,
  },
  {
    id: "pack-premium",
    label: tr("Premium check"),
    description: tr("Everything in Premium, pay-per-use"),
    checks: 1,
    price: 29000,
  },
];

export const PAYMENT_METHODS: {
  id: PaymentMethod;
  label: string;
  logo: string;
  comingSoon?: boolean;
  hasQr?: boolean;
}[] = [{ id: "vnpay", label: tr("VietQR"), logo: "/assets/logo/vnpay.png", hasQr: true }];

export const COMPETITORS = [
  {
    name: tr("University plagiarism tools"),
    audience: tr("Universities"),
    price: tr("Not sold directly"),
    limitation: tr("Hard for individuals to access"),
  },
  {
    name: tr("Generic plagiarism checkers"),
    audience: tr("Individuals"),
    price: "~$9.99/mo",
    limitation: tr("Not optimized for Vietnamese"),
  },
  {
    name: tr("Writing assistants"),
    audience: tr("Individuals"),
    price: "~$30/mo",
    limitation: tr("English-focused"),
  },
  {
    name: tr("Other checker apps"),
    audience: tr("Individuals"),
    price: "~$13.99/mo",
    limitation: tr("Weak Vietnamese semantic detection"),
  },
  {
    name: tr("Etymos"),
    audience: tr("Vietnamese users"),
    price: tr("From 69,000 VND/mo (~$2.7)"),
    limitation: tr("Vietnamese-optimized, Explainable AI, AI Rewrite"),
    highlight: true,
  },
];

export const FEATURE_MATRIX: {
  feature: string;
  free: boolean | string;
  student: boolean | string;
  professional: boolean | string;
}[] = [
  { feature: tr("Verification required"), free: false, student: tr("🎓 Yes"), professional: false },
  { feature: tr("Documents / month"), free: "2", student: "10", professional: "50" },
  { feature: tr("Words / document"), free: "3,000", student: "10,000", professional: "25,000" },
  { feature: tr("Traditional plagiarism detection"), free: true, student: true, professional: true },
  { feature: tr("Semantic (paraphrase) detection"), free: false, student: true, professional: true },
  { feature: tr("Explainable AI (why it's flagged)"), free: false, student: true, professional: true },
  { feature: tr("PDF report export"), free: false, student: true, professional: true },
  {
    feature: tr("AI Rewrite Assistant"),
    free: false,
    student: false,
    professional: true,
  },
  { feature: tr("Draft-over-time originality tracking"), free: false, student: false, professional: true },
  // { feature: "Multi-project management", free: false, student: false, professional: true },
  { feature: tr("History retention"), free: tr("7 days"), student: tr("9 months"), professional: tr("12 months") },
  { feature: tr("Support"), free: tr("Basic"), student: tr("Priority"), professional: tr("24/7 priority") },
];


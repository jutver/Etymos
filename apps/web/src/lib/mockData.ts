import type { CreditPack, PaymentMethod, PlanDefinition } from "@etymos/shared";

export const PLANS: PlanDefinition[] = [
  {
    id: "free",
    name: "Free",
    tagline: "Get started and try a real check",
    priceMonthly: 0,
    priceAnnual: 0,
    audience: "New users, occasional checks",
    features: [
      "2 documents / month, up to 3,000 words each",
      "Traditional plagiarism detection",
      "Similarity score & matched sources",
      "Basic report",
      "7-day history",
    ],
  },
  {
    id: "student",
    name: "Standard",
    tagline: "For students, grad and PhD researchers",
    priceMonthly: 69000,
    priceAnnual: 490000,
    audience: "Students, grad & PhD researchers",
    mostPopular: true,
    requiresVerification: true,
    features: [
      "10 documents / month, up to 10,000 words each",
      "Semantic plagiarism detection",
      "Explainable AI, in plain language",
      "Multi-language checking",
      "PDF export",
      "9-month history",
      "Priority support",
    ],
  },
  {
    id: "professional",
    name: "Premium",
    tagline: "For lecturers, researchers & agencies",
    priceMonthly: 199000,
    priceAnnual: 1790000,
    audience: "Lecturers, researchers, content & SEO teams",
    features: [
      "50 documents / month, up to 25,000 words each",
      "Everything in Standard",
      "AI Rewrite Assistant",
      "Multi-project management",
      "In-depth advanced report export",
      "Draft-over-time originality tracking",
      "12-month history",
      "24/7 priority support",
    ],
  },
];

export const CREDIT_PACKS: CreditPack[] = [
  {
    id: "pack-standard",
    label: "Standard check",
    description: "Everything in Standard, pay-per-use",
    checks: 1,
    price: 19000,
  },
  {
    id: "pack-premium",
    label: "Premium check",
    description: "Everything in Premium, pay-per-use",
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
}[] = [{ id: "vnpay", label: "VietQR", logo: "/assets/logo/vnpay.png", hasQr: true }];

export const COMPETITORS = [
  {
    name: "University plagiarism tools",
    audience: "Universities",
    price: "Not sold directly",
    limitation: "Hard for individuals to access",
  },
  {
    name: "Generic plagiarism checkers",
    audience: "Individuals",
    price: "~$9.99/mo",
    limitation: "Not optimized for Vietnamese",
  },
  {
    name: "Writing assistants",
    audience: "Individuals",
    price: "~$30/mo",
    limitation: "English-focused",
  },
  {
    name: "Other checker apps",
    audience: "Individuals",
    price: "~$13.99/mo",
    limitation: "Weak Vietnamese semantic detection",
  },
  {
    name: "Etymos",
    audience: "Vietnamese users",
    price: "From 69,000 VND/mo (~$2.7)",
    limitation: "Vietnamese-optimized, Explainable AI, AI Rewrite",
    highlight: true,
  },
];

export const FEATURE_MATRIX: {
  feature: string;
  free: boolean | string;
  student: boolean | string;
  professional: boolean | string;
}[] = [
  { feature: "Verification required", free: false, student: "🎓 Yes", professional: false },
  { feature: "Documents / month", free: "2", student: "10", professional: "50" },
  { feature: "Words / document", free: "3,000", student: "10,000", professional: "25,000" },
  { feature: "Traditional plagiarism detection", free: true, student: true, professional: true },
  { feature: "Semantic (paraphrase) detection", free: false, student: true, professional: true },
  { feature: "Explainable AI (why it's flagged)", free: false, student: true, professional: true },
  { feature: "PDF report export", free: false, student: true, professional: true },
  {
    feature: "AI Rewrite Assistant",
    free: false,
    student: false,
    professional: true,
  },
  { feature: "Draft-over-time originality tracking", free: false, student: false, professional: true },
  // { feature: "Multi-project management", free: false, student: false, professional: true },
  { feature: "History retention", free: "7 days", student: "9 months", professional: "12 months" },
  { feature: "Support", free: "Basic", student: "Priority", professional: "24/7 priority" },
];

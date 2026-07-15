-- Seeds plan_definitions/credit_packs to match apps/web/src/lib/mockData.ts's
-- current PLANS/CREDIT_PACKS values, so the admin ops/config panel has real
-- starting data to edit. Safe to re-run (upsert on primary key).

insert into public.plan_definitions
  (id, name, tagline, price_monthly, price_annual, audience, most_popular, requires_verification, features, doc_limit, word_limit, sort_order)
values
  (
    'free', 'Free', 'Get started and try a real check', 0, 0,
    'New users, occasional checks', false, false,
    array[
      '2 documents / month, up to 3,000 words each',
      'Traditional plagiarism detection',
      'Similarity score & matched sources',
      'Basic report',
      '7-day history'
    ],
    2, 3000, 1
  ),
  (
    'student', 'Standard', 'For students, grad and PhD researchers', 69000, 490000,
    'Students, grad & PhD researchers', true, true,
    array[
      '10 documents / month, up to 10,000 words each',
      'Semantic plagiarism detection',
      'Explainable AI, in plain language',
      'Multi-language checking',
      'PDF export',
      '9-month history',
      'Priority support'
    ],
    10, 10000, 2
  ),
  (
    'professional', 'Premium', 'For lecturers, researchers & agencies', 199000, 1790000,
    'Lecturers, researchers, content & SEO teams', false, false,
    array[
      '50 documents / month, up to 25,000 words each',
      'Everything in Standard',
      'AI Rewrite Assistant',
      'Multi-project management',
      'In-depth advanced report export',
      'Draft-over-time originality tracking',
      '12-month history',
      '24/7 priority support'
    ],
    50, 25000, 3
  )
on conflict (id) do update set
  name = excluded.name,
  tagline = excluded.tagline,
  price_monthly = excluded.price_monthly,
  price_annual = excluded.price_annual,
  audience = excluded.audience,
  most_popular = excluded.most_popular,
  requires_verification = excluded.requires_verification,
  features = excluded.features,
  doc_limit = excluded.doc_limit,
  word_limit = excluded.word_limit,
  sort_order = excluded.sort_order,
  updated_at = now();

insert into public.credit_packs (id, label, description, checks, price, sort_order)
values
  ('pack-standard', 'Standard check', 'Everything in Standard, pay-per-use', 1, 19000, 1),
  ('pack-premium', 'Premium check', 'Everything in Premium, pay-per-use', 1, 29000, 2)
on conflict (id) do update set
  label = excluded.label,
  description = excluded.description,
  checks = excluded.checks,
  price = excluded.price,
  sort_order = excluded.sort_order,
  updated_at = now();

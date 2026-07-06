# Etymos — Product Design & Build Spec

**For a coding agent.** This document is a design + build brief for the front-end of **Etymos**, a plagiarism-detection web app. You are being handed this to **re-design and build the UI in code** — treat the accompanying wireframes and any earlier prototype as *directional references only*, not a fixed design. Improve on them freely. Everything you need to understand the product, its screens, its visual direction, and its subscription tiers is in this document and the two attached reference files.

---

## How to Use This Spec

- **Goal:** build a polished, clickable, desktop-first web front-end for Etymos, navigable as a real multi-screen app (each screen is its own route/view; linked controls navigate between them). Aim for **deployment quality** — this should look and feel like the real shipped product, not a rough mockup.
- **Fidelity — build every state, not just the happy path:** design and implement empty, loading, hover, active, focus, disabled, error, success, locked, and limit-reached states for every relevant component. Use real, believable microcopy (no lorem ipsum, no "TODO" gaps), consistent spacing, and pixel-level polish throughout. Someone demoing this shouldn't be able to tell it from a finished product by looking.
- **Re-design encouraged:** the wireframes show intended *structure and flow*. You may restyle, re-lay-out, and improve components to raise quality — keep the information architecture and userflow intact.
- **Scope (assumption — change if told otherwise):** front-end with realistic **mock data and mock payment** — real plagiarism detection, AI models, auth, and live payment processing are stubbed. But everything the user sees and clicks should behave convincingly end-to-end — **including running out of credits and paying to continue** — even though nothing hits a real backend.
- **Name:** the product is **Etymos**. The attached wireframes are labeled "PlagioCheck" — that is an **old name**; ignore it and use "Etymos" everywhere.

### Attached reference files
1. **Wireframe PDF** — 6 screens showing intended structure/flow (structural reference only).
2. **Blue-gradient image** — the brand color direction (see Visual Direction).

---

## What Etymos Is

Etymos is a plagiarism-detection web app for **students and individual researchers** — a more affordable, accessible alternative to tools like Turnitin, **optimized for Vietnamese** (and multi-language). Core capabilities:

1. **Traditional plagiarism detection** — matches against both academic papers and public websites, with a Similarity Score and matched-source suggestions.
2. **Semantic plagiarism detection** — catches reworded/paraphrased copying, not just verbatim matches.
3. **Explainable AI** — explains, in plain natural language, **why** a flagged passage counts as plagiarism (not just a %).
4. **AI Rewrite Assistant** — paraphrases flagged passages to an academic standard in one click.
5. **AI-generated content detection** — flags text likely produced by ChatGPT/Gemini and similar.
6. **Multi-language, Vietnamese-first** — tuned for Vietnamese academic writing; supports other languages.

### Target users
- **Primary:** university students, master's students, PhD researchers.
- **Secondary:** lecturers, researchers, freelancers, SEO/content writers, agencies.

---

## Design Craft & Role

Act as a **senior product designer and front-end engineer** shipping a polished SaaS product — not generating a template. Etymos should look **professional, elegant, and energetic**: trustworthy enough for academic work, with enough life and momentum that it feels modern rather than sterile.

Avoid the generic "AI-generated" look. Concretely:

- No default purple/indigo-on-white gradients everywhere; commit to the blue palette below with **restraint and real contrast**.
- Avoid centered-everything layouts, identical evenly-spaced feature cards, and the stock hero + three-cards + CTA rhythm on every screen. **Vary composition** — asymmetry, differing section layouts, intentional focal points.
- No filler emoji-as-icons or clip-art. Use a **clean, consistent icon set**.
- Real type hierarchy and deliberate spacing — not everything the same weight and size. Pick a **distinctive but readable geometric sans** and use scale purposefully.
- **Purposeful detail over decoration:** subtle depth, considered whitespace, micro-alignment. Deliberate decisions, not safe defaults.

The result should feel like a real product a startup would ship — energetic and confident, but clean and credible for an academic audience.

---

## Visual Direction (from the reference image)

- **Primary brand look:** the diagonal blue gradient in the attached image — light sky-cyan (top-left) into saturated royal/azure blue. Sample from the image. Approx palette if needed:
  - gradient light `~#9FD2F0` → gradient deep `~#2C5FD6` / `#1E4FC4`
  - dark accent / footer navy `~#0F1B3D`
  - backgrounds: white and very-light blue `~#F5FAFF`
  - text: dark slate `~#1A2233`
- **Use the gradient on:** landing hero, primary buttons/CTAs, active-state accents, the similarity-score badge. Use dark-navy cards for feature highlights and app header/nav where contrast helps.
- **Style:** modern, airy, tech-forward — generous whitespace, rounded corners (8–16px), soft shadows, clean geometric sans, clear hierarchy.

### Keep result-indicator colors functional (do not make them blue)
Match highlights use their own color system, kept visually separate from the blue brand chrome so they stay legible:
- **High match** → red / rose
- **Moderate match** → amber
- **Low / common phrasing** → soft yellow
- **AI-generated content** → a distinct 4th color (e.g. violet/teal) so it reads as a *different kind* of signal from plagiarism, not a severity level.

---

## Layout & Responsiveness

- **Desktop-first, primary target 1920×1080.** Design the above-the-fold view of each screen to read well at 1080px height.
- Pages that naturally scroll (Landing, Report/Editor) may extend taller — don't cram content to force a 1080 cap.
- Build **responsive**: the layout should degrade gracefully to smaller desktop and tablet widths. Mobile is lower priority but shouldn't break.
- Build each screen as its **own route/view** with real navigation between them, so the whole thing runs as one clickable click-through.

---

## Subscription Tiers & Feature Gating

Etymos uses **Freemium + Subscription + Pay-per-use** (with Enterprise/education licensing planned later). The UI must reflect these tiers: what each plan includes, and how features are **locked or limited** for lower tiers. Prices are in Vietnamese đồng (VND).

> ⚠️ **Price discrepancy to reconcile:** the Business Model Canvas lists Student Premium at 79,000 and Professional at 199,000, but the dedicated pricing section lists **99,000** and **299,000**. This spec uses the **pricing-section figures (99,000 / 299,000)** as authoritative. Confirm the final numbers before the pitch.

### The three plans

**Free — 0 VND/month** · *new users, trial*
- Up to **3 documents / month**, max **3,000 words / document**
- Traditional plagiarism detection
- Similarity Score
- Matched-source suggestions
- Basic report
- History kept **7 days**
- **Ads shown**
- Premium features are **visible but locked**, with upgrade prompts when limits are hit

**Student Premium — 99,000 VND/month (~$3.8)** · *students, grad/PhD — CORE plan, mark "Most popular"*
Everything in Free, plus:
- **Unlimited** document checks, **unlimited** words
- Semantic Plagiarism Detection
- AI-generated Content Detection
- Explainable AI (detailed, plain-language explanations)
- AI Rewrite Assistant
- Multi-language checking
- **PDF report export**
- History kept **12 months**
- **No ads**
- Priority support

**Professional — 299,000 VND/month** · *lecturers, researchers, content/SEO writers, agencies*
Everything in Student Premium, plus:
- **Batch checking** (many documents at once)
- **Statistics dashboard**
- **Multi-project management**
- **API integration**
- In-depth / advanced report export
- **Team roles & permissions**
- **24/7** priority technical support

### Pay-per-use credit packs (for users who don't want a subscription)
| Pack | Price |
| --- | --- |
| 1 check | 19,000 VND |
| 5 checks | 89,000 VND |
| 10 checks | 169,000 VND |

### Feature comparison (drives both the Pricing table and in-app gating)
| Feature | Free | Student Premium | Professional |
| --- | :---: | :---: | :---: |
| Traditional plagiarism detection | ✓ | ✓ | ✓ |
| Similarity Score | ✓ | ✓ | ✓ |
| Matched-source suggestions | ✓ | ✓ | ✓ |
| Semantic Plagiarism Detection | ✗ | ✓ | ✓ |
| Explainable AI (why it's flagged) | ✗ | ✓ | ✓ |
| AI Rewrite Assistant | ✗ | ✓ | ✓ |
| AI-generated Content Detection | ✗ | ✓ | ✓ |
| Multi-language checking | ✗ | ✓ | ✓ |
| PDF export | ✗ | ✓ | ✓ |
| No ads | ✗ | ✓ | ✓ |
| Documents / month | 3 | Unlimited | Unlimited |
| Words / document | 3,000 | Unlimited | Unlimited |
| History retention | 7 days | 12 months | 12 months |
| Batch checking | ✗ | ✗ | ✓ |
| Statistics dashboard | ✗ | ✗ | ✓ |
| Multi-project management | ✗ | ✗ | ✓ |
| API integration | ✗ | ✗ | ✓ |
| Team roles & permissions | ✗ | ✗ | ✓ |
| Support | Basic | Priority | 24/7 priority |

### Gating behavior to build into the UI
- **Free tier:** show locked-feature states (e.g. Explainable AI, AI Rewrite, Semantic/AI detection appear but are visibly locked with an "Upgrade" affordance). Show a **usage meter** (e.g. "2 of 3 checks used this month") and an **upgrade prompt / paywall** when a limit is reached. Include a subtle **ad slot** in the Free experience.
- **Report screen has two experiences:** Free shows Similarity Score + matched sources + basic report only; Premium unlocks the plain-language explanations, semantic + AI-content signals, and the Rewrite panel. Design the locked state to double as an upsell.
- Make **upgrade CTAs** feel encouraging, not nagging.

### Out-of-credits / paywall flow (must be fully demoable)
This is the core monetization moment and should be shown in the demo: **when a user has no checks left, they cannot run a check until they either subscribe or buy credits.** Build it end-to-end at full fidelity:

1. **Balance always visible.** Show remaining balance in the header/nav and on the Upload screen — Free users see "X of 3 checks left this month"; pay-per-use users see a **credit balance** (e.g. "2 credits"). As it depletes, surface a low-balance nudge (e.g. at 1 left).
2. **Hitting zero.** When the user presses "Check for plagiarism" with **0 remaining**, do **not** run the check. Instead open a **blocking paywall** (modal or dedicated screen) that clearly says they're out and presents **two paths**:
   - **Subscribe** → Student Premium (99,000/mo) or Professional (299,000/mo) — framed as the best value for regular use.
   - **Buy credits** (usage-based) → the 19,000 / 89,000 / 169,000 packs — for one-off needs.
3. **Checkout.** Selecting either path goes to a **Checkout screen**: order summary (chosen plan or pack + price), **payment-method** selection (VNPay, MoMo, ZaloPay — Etymos's payment partners), and a Confirm & Pay button. Include a **processing/loading** state and a **declined/error** state. Mock payment — no real processing.
4. **Success + resume.** Show a **payment-success** confirmation, update the visible balance/plan across the app, and return the user to the pending check so they can continue — demonstrating the full **blocked → pay → unblocked** loop.

This loop is the single most important thing to nail for the demo, so give it the most polish.

### Competitor benchmark (for the Pricing page + landing comparison)
| Platform | For | Reference price | Limitation |
| --- | --- | --- | --- |
| Turnitin | Universities | Not sold directly | Hard for individuals to access |
| Copyleaks | Individuals | ~$9.99/mo | Not optimized for Vietnamese |
| Grammarly Premium | Individuals | ~$30/mo | English-focused |
| Quetext Pro | Individuals | ~$13.99/mo | Weak Vietnamese semantic detection |
| **Etymos** | Vietnamese users | **~99,000 VND/mo (~$3.8)** | Vietnamese-optimized, Explainable AI, AI Rewrite |

---

## Screens to Build (each its own route, in flow order)

**00 · Landing / Get Started** — public homepage: nav (Features, How it works, Pricing, Log in) + "Get Started"; hero with headline, value prop, CTAs, product screenshot; feature cards covering the core capabilities (incl. AI-content detection and Vietnamese optimization); how-it-works (Upload → Scan web + academic → Review, understand, rewrite); an **affordability/accessibility angle** using the benchmark above; testimonial slots; closing CTA band; footer.

**01 · Upload / Home** — drag-and-drop file (PDF/DOC/TXT) or paste-text tab; toggles for [Web sources] [Academic papers]; language selector (Vietnamese/English/…); "Check for plagiarism" button; recent checks list; **balance indicator** — Free users see a **usage meter** ("X of 3 checks left this month"), pay-per-use users see a **credit balance**. If balance is **0**, the check button routes to the paywall (screen 08) instead of running.

**02 · Analyzing** — progress state with steps (extracting text, scanning web, comparing academic papers, running semantic + AI-content detection, generating explanations).

**03 · Report / Editor** *(core screen — most detail)* — top bar with document title, prominent **Similarity Score badge**, an **AI-generated-content indicator** (Premium), and Export.
  - **Left ~65%:** submitted document with matched passages highlighted inline (severity colors).
  - **Right ~35%:** scrollable match cards — each with matched source + match %, overlapping snippet, a **plain-language explanation of why it's flagged** (Explainable AI), and buttons "View source comparison" + "Rewrite with AI".
  - **Free vs Premium:** Free shows score + matched sources + basic report; explanations, semantic/AI-content signals, and rewrite are **locked with upgrade prompts**.

**04 · Source Comparison** *(modal over Report)* — side-by-side: user's passage vs original source, overlapping words highlighted in both, with % and citation.

**05 · AI Rewrite Assist** *(slide-over panel — Premium)* — flagged original passage on top; AI paraphrase below; controls for Regenerate, tone/length, "Accept & replace", "Copy"; note that accepting recalculates the score.

**06 · Dashboard / History** — table of past documents (name, date, similarity, status); row click opens its Report. History depth reflects tier (7 days Free / 12 months Premium). For **Professional**, add a **statistics dashboard** view and multi-project grouping.

**07 · Pricing / Plans** — monthly/annual toggle; **three plan cards (Free / Student Premium / Professional)**, middle marked "Most popular", each with price, target user, and included-features checklist (use the tier lists above); a **pay-per-use credit-pack** section; the **full feature-comparison table**; a short competitor-comparison strip; a short FAQ.

**08 · Out-of-Credits Paywall** *(blocking modal or screen)* — triggered when a user with 0 remaining tries to run a check. Clearly states they're out of checks; presents **two paths side by side**: **Subscribe** (Student Premium / Professional) or **Buy credits** (19k / 89k / 169k packs). Encouraging tone, not punitive. "Maybe later" dismisses back to the previous screen (the check stays blocked).

**09 · Checkout / Payment** — order summary for the selected plan or credit pack (item, billing period if a subscription, price, total); **payment-method** selection (VNPay, MoMo, ZaloPay); "Confirm & Pay" button; a **processing/loading** state; and a **declined/error** state. Mock payment only.

**10 · Payment Success** — confirmation showing what was purchased and the **new balance/plan**; primary CTA to **resume the check** (or return to Upload). Balance/plan indicators across the app now reflect the purchase.

---

## Navigation / Interaction Flows (wire these)

- Landing "Get Started" / hero CTA → **01 Upload**; Landing "Pricing" → **07 Pricing**; Pricing CTA → **01 Upload** (or sign-up)
- Upload "Check for plagiarism" → **02 Analyzing** → auto-advances → **03 Report**
- Report match card "View source comparison" → **04**; "Rewrite with AI" → **05**; "Export" → download state; nav "History" → **06**
- Dashboard row click → **03 Report**
- "Check for plagiarism" with **0 balance** → **08 Paywall** (check is blocked, not run)
- Paywall "Subscribe" or "Buy credits" → **09 Checkout** → Confirm & Pay → processing → **10 Success** → **resume the pending check** (→ 02 Analyzing)
- Any locked Premium control / hitting a Free limit → **08 Paywall** (to convert) or **07 Pricing** (to compare plans)

Use realistic placeholder copy and **consistent sample data across screens** (one running example document) so it demos convincingly. Add subtle hover/active states on buttons and cards.

---

## Implementation Notes (clean, maintainable front-end)

- **Design tokens up front:** centralize color (gradient stops, navy, backgrounds, text, the result-indicator colors), a named type scale (Display / H1 / H2 / Body / Caption), and a spacing scale (4/8px grid). Reference tokens everywhere — no hard-coded one-off values.
- **Componentize repeated elements:** buttons (with states), top nav, feature card, match card, similarity/AI badges, input/upload field, plan card, comparison-table row, usage meter, locked-feature overlay. Reuse across screens.
- **Keep text as live text** and **icons as vectors/SVG.**
- **Vietnamese/Unicode support:** ensure fonts and inputs render Vietnamese diacritics correctly; the running sample content should reflect the target market (see note in handoff).
- **Accessibility:** sufficient contrast (watch text over the blue gradient), focus states, keyboard nav, semantic HTML.
- **Naming:** clear, consistent component and route names (e.g. `LandingPage`, `ReportEditor`, `PricingPage`).

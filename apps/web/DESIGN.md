---
name: Etymos
description: Vietnamese-first plagiarism and AI-content detection with explainable, plain-language reasoning
colors:
  confidence-blue-light: "#9FD2F0"
  confidence-blue-mid: "#2C5FD6"
  confidence-blue-deep: "#1E4FC4"
  ink-navy: "#0F1B3D"
  paper-white: "#FFFFFF"
  mist-tint: "#F5FAFF"
  surface-muted: "#EEF3FB"
  ink-900: "#1A2233"
  ink-500: "#5C6680"
  line: "#E2E8F5"
  alert-red: "#DC2626"
  alert-red-bg: "#FEF2F2"
  caution-amber: "#D97706"
  caution-amber-bg: "#FFFBEB"
  notice-yellow: "#CA8A04"
  notice-yellow-bg: "#FEFCE8"
  signal-violet: "#7C3AED"
  signal-violet-bg: "#F5F3FF"
  confirmed-green: "#059669"
  confirmed-green-bg: "#ECFDF5"
typography:
  display:
    fontFamily: "Be Vietnam Pro, ui-sans-serif, system-ui, sans-serif"
    fontSize: "3.5rem"
    fontWeight: 800
    lineHeight: 1.08
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Be Vietnam Pro, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2.5rem"
    fontWeight: 700
    lineHeight: 1.12
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Be Vietnam Pro, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 700
    lineHeight: 1.3
  body:
    fontFamily: "Be Vietnam Pro, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Be Vietnam Pro, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: 1.5
rounded:
  input: "0.625rem"
  control: "0.75rem"
  card: "1rem"
  card-lg: "1.25rem"
  pill: "9999px"
spacing:
  card-padding: "1.5rem"
  section-y: "4rem"
  section-y-lg: "6rem"
components:
  button-primary:
    backgroundColor: "{colors.confidence-blue-deep}"
    textColor: "{colors.paper-white}"
    rounded: "{rounded.control}"
    padding: "0 1.25rem"
    height: "2.75rem"
  button-primary-hover:
    backgroundColor: "{colors.confidence-blue-mid}"
  button-secondary:
    backgroundColor: "{colors.ink-navy}"
    textColor: "{colors.paper-white}"
    rounded: "{rounded.control}"
    padding: "0 1.25rem"
  button-outline:
    backgroundColor: "{colors.paper-white}"
    textColor: "{colors.ink-900}"
    rounded: "{rounded.control}"
    padding: "0 1.25rem"
  card:
    backgroundColor: "{colors.paper-white}"
    rounded: "{rounded.card-lg}"
    padding: "{spacing.card-padding}"
  badge-severity-high:
    backgroundColor: "{colors.alert-red-bg}"
    textColor: "{colors.alert-red}"
    rounded: "{rounded.pill}"
    padding: "0.25rem 0.625rem"
  badge-ai-flag:
    backgroundColor: "{colors.signal-violet-bg}"
    textColor: "{colors.signal-violet}"
    rounded: "{rounded.pill}"
    padding: "0.25rem 0.625rem"
---

# Design System: Etymos

## 1. Overview

**Creative North Star: "The Clear Verdict"**

Etymos exists to replace an opaque percentage with a reason. Where competing tools hand a student a red number and walk away, Etymos hands them a verdict they can act on: what matched, which source, and why in plain language. Every design decision in this system serves that one idea, legibility over intimidation, clarity over decoration. The system is professional enough to stand behind academic integrity, energetic enough to feel like a real 2026 product rather than a university IT portal, and precise enough that its own functional color-coding never lies to the user about severity.

This system explicitly rejects the generic AI-tool look: no default purple/indigo-on-white gradients, no centered-hero-plus-three-identical-cards template rhythm, no filler emoji standing in for icons. The blue brand gradient is confident but restrained: it appears on primary actions, active accents, and the similarity badge, never as ambient decoration behind body copy.

**Key Characteristics:**
- One brand hue (confidence blue), used with intent, never diluted into a rainbow of accent colors
- A hard wall between brand color and functional/result color: severity red, amber, and yellow, plus the violet AI-content signal, are never confused with the blue brand chrome
- Navy carries authority (nav, footer, dark bands); blue carries action (buttons, active states, the score badge)
- Generous card radii and soft, navy-tinted shadows, never a pure black shadow

## 2. Colors

The palette is deliberately small: one confident blue gradient for the brand, ink navy for authority surfaces, and four functional colors reserved exclusively for detection results, never used decoratively.

### Primary
- **Confidence Blue** (`#9FD2F0` → `#1E4FC4`, mid-stop `#2C5FD6`): the diagonal brand gradient. Used on primary buttons, the landing hero, active nav/tab states, and the Similarity Score badge ring. Always a gradient when it appears at meaningful size; never flattened to a single mid-tone except for small text/icon accents.

### Neutral
- **Ink Navy** (`#0F1B3D`): the authority surface. In-app header/nav, footer, and full-width marketing bands that need contrast and gravity.
- **Paper White** (`#FFFFFF`): primary content surface.
- **Mist Tint** (`#F5FAFF`): the app's background wash behind cards, distinguishing "page" from "card" without a border.
- **Ink 900** (`#1A2233`): body and heading text.
- **Ink 500** (`#5C6680`): secondary/metadata text.
- **Line** (`#E2E8F5`): hairline borders and dividers.

### Named Rules
**The Functional Wall Rule.** Severity red, caution amber, notice yellow, and signal violet exist in a color system totally separate from Confidence Blue. If a designer reaches for blue to indicate a detection result, that's a violation: blue means brand and action, never a plagiarism signal.

**The One Gradient Rule.** The brand gradient appears at full strength in a small, fixed set of places (primary CTA, hero, score badge, closing CTA band). It does not leak into card backgrounds, table rows, or body text as decoration.

### Functional (result) colors
- **Alert Red** (`#DC2626` on `#FEF2F2`): high-severity plagiarism match.
- **Caution Amber** (`#D97706` on `#FFFBEB`): moderate-severity match.
- **Notice Yellow** (`#CA8A04` on `#FEFCE8`): low-severity / common-phrasing match.
- **Signal Violet** (`#7C3AED` on `#F5F3FF`): AI-generated-content detection, a deliberately different color family (not a severity level) so it reads as a different kind of signal.
- **Confirmed Green** (`#059669` on `#ECFDF5`): resolved/clean states, successful payment, "no issues found."

## 3. Typography

**Display/Body Font:** Be Vietnam Pro (with `ui-sans-serif, system-ui` fallback)

**Character:** A single geometric sans, self-hosted with full Vietnamese diacritic coverage, carries every weight from hero display down to caption. One family, used with real weight and scale contrast, rather than a display/body pairing.

### Hierarchy
- **Display** (800, 3.5rem, line-height 1.08, letter-spacing -0.02em): landing hero headline only.
- **Headline** (700, 2.5rem, line-height 1.12): page-level H1s (Pricing, Dashboard, Paywall).
- **Title** (700, 1.375rem, line-height 1.3): card and section-level H3s (report top bar title, plan card names).
- **Body** (400, 0.9375rem, line-height 1.6): all paragraph and UI copy; capped near 62ch in the report document viewer for readability.
- **Label** (600, 0.8125rem, line-height 1.5): eyebrows, badge text, table headers, uppercase micro-labels.

### Named Rules
**The Single-Family Rule.** No second typeface is introduced for "emphasis" or "editorial" moments. Weight, size, and color carry hierarchy; the font never changes.

## 4. Elevation

Etymos is flat-by-default with soft, navy-tinted shadows appearing only on floating or interactive-forward surfaces (cards, modals, the pricing "most popular" plan). Shadows are never pure black; they're tinted `rgba(15, 27, 61, …)` so they read as a soft lift off the mist-blue background rather than a harsh drop.

### Shadow Vocabulary
- **card** (`0 1px 2px rgba(15,27,61,0.04), 0 8px 24px -12px rgba(15,27,61,0.12)`): default resting elevation for cards.
- **card-hover** (`0 2px 4px rgba(15,27,61,0.06), 0 16px 32px -12px rgba(15,27,61,0.18)`): hover/toast elevation.
- **pop** (`0 12px 40px -8px rgba(15,27,61,0.28)`): modals, slide-overs, dropdown menus, the most-popular plan card.

### Named Rules
**The Tinted Shadow Rule.** Every shadow is tinted toward ink navy, never neutral gray or pure black. A gray shadow on this palette reads as generic-template; the navy tint keeps it feeling native to the brand.

## 5. Components

### Buttons
- **Shape:** fully rounded corners on the control scale (12px / `rounded.control`), not pill-shaped. Height 2.75rem at default size.
- **Primary:** Confidence Blue gradient fill, white text, soft blue-tinted glow shadow. Reserved for the single most important action per screen (Get Started, Check for plagiarism, Confirm & Pay).
- **Secondary:** solid Ink Navy fill, white text. Used for the second-priority action beside a primary (e.g. "See a real report").
- **Outline:** white fill, ink text, hairline border; brightens to a blue border on hover. Used for tertiary actions and for reversible choices (payment method cards, "Try again").
- **Ghost:** transparent, ink-700 text, subtle surface-muted fill on hover. Used for nav links and low-emphasis actions.
- **Hover / Active:** primary brightens (`brightness-108`) and its shadow deepens; all buttons scale to 0.98 on `:active` for tactile feedback.

### Badges & Pills
- **Style:** fully pill-shaped (`rounded.pill`), tinted background matching the semantic role's `-bg` color, text in the matching foreground color, small colored dot for severity tags.
- **Locked state:** a lock icon + "Premium" label in the brand-blue tint, never in a functional color, since locking is a brand/upsell moment, not a detection result.

### Cards / Containers
- **Corner Style:** 16px (`rounded.card-lg`) for page-level cards (plan cards, report panels, paywall cards); 12–16px for nested cards (match cards, stat tiles).
- **Background:** paper white on the mist-tint page background.
- **Shadow Strategy:** `card` at rest; `pop` for anything overlaying the page (modals, slide-overs, popular-plan emphasis).
- **Border:** 1px `line` hairline by default; brand-blue border on hover/selected states (payment method, plan selection).

### Inputs / Fields
- **Style:** 10px radius (`rounded.input`), hairline border, mist-tint or white background depending on context (textarea vs. search field).
- **Focus:** border shifts to Confidence Blue mid-tone plus a soft blue focus ring (`ring-2 ring-brand-200`).
- **Toggle switches:** pill track, brand-blue when on, translucent ink when off; used for Web/Academic source toggles.

### Navigation
- **Public (marketing) nav:** white, sticky, 68px tall, single-line link row, becomes a slide-down sheet under `lg`.
- **App (product) nav:** Ink Navy, 68px tall, white/60%-opacity link text that goes full-white when active, balance indicator always visible, collapses to a hamburger sheet under `md`.

### Signature Component: Locked Overlay
A blurred preview of the gated content sits behind a solid white scrim, centered lock icon in a brand-blue circle, one line of benefit copy, and an "Upgrade to unlock" primary button. Every premium gate uses this exact pattern so locking always reads as an invitation, never a dead end.

## 6. Do's and Don'ts

### Do:
- **Do** keep the brand gradient confined to primary CTAs, the hero, the score badge ring, and full-width closing bands (**The One Gradient Rule**).
- **Do** tint every shadow toward ink navy (`rgba(15,27,61,…)`), never neutral gray (**The Tinted Shadow Rule**).
- **Do** show locked Premium content blurred-behind-a-scrim with a clear unlock CTA, never simply hidden.
- **Do** render all Vietnamese sample and UI copy with full diacritic support (Be Vietnam Pro's Vietnamese charset), since Vietnamese-first is the product's core differentiator.
- **Do** vary section composition (asymmetric hero, bento grid, horizontal scroll strip, stacked testimonials) rather than repeating the same card-row rhythm.

### Don't:
- **Don't** use blue for a plagiarism-severity or AI-content signal; those are red, amber, yellow, and violet only (**The Functional Wall Rule**).
- **Don't** default to purple/indigo-on-white AI-gradient looks, per PRODUCT.md's anti-references.
- **Don't** repeat the centered-hero-plus-three-identical-feature-cards template rhythm anywhere in the marketing surfaces.
- **Don't** use filler emoji as icons; Phosphor icons only, consistent stroke weight.
- **Don't** introduce a second typeface for "emphasis"; Be Vietnam Pro carries every weight and size in the system (**The Single-Family Rule**).
- **Don't** use a pure-black or ungapped default `box-shadow`; every shadow in this system is soft and navy-tinted.

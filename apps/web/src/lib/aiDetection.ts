// Maps the backend's `ai_detection` block (snake_case JSON, as written by
// backend/ai_detector.py into the report and into `documents.ai_detection`) to
// the camelCase `AiDetection` the UI uses. Shared by the live check path
// (Analyzing) and the reload path (documentsQueries) so both read it the same
// way. Tolerant on purpose: anything unrecognised becomes `undefined` — the
// report then simply shows no AI chip — rather than throwing.
import type { AiDetection, AiDetectionLevel, AiDetectionSegment, AiSegmentFeatures } from "@etymos/shared";
import { t, tr } from "./i18n";

const LEVELS: readonly AiDetectionLevel[] = ["low", "possible", "likely"];

function num(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function optionalNum(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** backend/ai_detector.py summarize(): segment["features"] = {mean_nll, top1_frac, sent_std}. */
function parseSegmentFeatures(raw: unknown): AiSegmentFeatures | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const f = raw as Record<string, unknown>;
  const features: AiSegmentFeatures = {
    meanNll: optionalNum(f.mean_nll),
    topOneShare: optionalNum(f.top1_frac),
    sentenceSpread: optionalNum(f.sent_std),
    binoculars: optionalNum(f.binoculars),
    classifierAiScore: optionalNum(f.ai_score),
  };
  return Object.values(features).some((v) => v !== undefined) ? features : undefined;
}

export function parseAiDetection(raw: unknown): AiDetection | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;

  if (r.available === false) {
    return { available: false, reason: typeof r.reason === "string" ? r.reason : undefined };
  }
  if (r.available !== true) return undefined;

  const level = LEVELS.includes(r.level as AiDetectionLevel) ? (r.level as AiDetectionLevel) : "low";
  const segments: AiDetectionSegment[] = Array.isArray(r.segments)
    ? r.segments
        .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
        .map((s) => ({
          start: num(s.start),
          end: num(s.end),
          blockId: typeof s.block_id === "string" ? s.block_id : null,
          words: num(s.words),
          score: num(s.score),
          excerpt: typeof s.excerpt === "string" ? s.excerpt : undefined,
          features: parseSegmentFeatures(s.features),
        }))
    : [];

  return {
    available: true,
    method: typeof r.method === "string" ? r.method : "",
    model: typeof r.model === "string" ? r.model : "",
    overallScore: num(r.overall_score),
    level,
    confidence: r.confidence === "normal" ? "normal" : "low",
    language: typeof r.language === "string" ? r.language : "unknown",
    analyzedWords: num(r.analyzed_words),
    aiShare: num(r.ai_share),
    segments,
    reasons: Array.isArray(r.reasons) ? r.reasons.filter((x): x is string => typeof x === "string") : [],
    disclaimer: typeof r.disclaimer === "string" ? r.disclaimer : "",
    ...(r.inconclusive === true ? { inconclusive: true } : {}),
  };
}

/** Human label for a level, used by the chip and the detail dialog. */
export function aiLevelLabel(level: AiDetectionLevel): string {
  return level === "likely" ? t("Likely AI-written") : level === "possible" ? t("Possibly AI-assisted") : t("Mostly human-written");
}

/** Label for a detection result: "not enough evidence" when it is inconclusive (detector mode 1). */
export function aiDetectionLabel(detection: { level: AiDetectionLevel; inconclusive?: boolean }): string {
  return detection.inconclusive ? t("Not enough evidence to judge") : aiLevelLabel(detection.level);
}

// The detector's reasons and disclaimer are written by the backend in English
// (backend/ai_detector.py), with numbers baked in. To show them in the UI language
// each known sentence is matched by pattern and rendered from a catalog key with
// the numbers passed as parameters. Anything unrecognised is shown as-is.
const REASON_PATTERNS: readonly { re: RegExp; key: string; params: readonly string[] }[] = [
  {
    re: /^The wording is very predictable to a language model \(perplexity ≈ (\d+), versus ≈ (\d+) for typical human academic writing\); machine-written text tends to pick the most expected word\.$/,
    key: tr(
      "The wording is very predictable to a language model (perplexity ≈ {{n}}, versus ≈ {{typical}} for typical human academic writing); machine-written text tends to pick the most expected word.",
    ),
    params: ["n", "typical"],
  },
  {
    re: /^The wording is fairly unpredictable \(perplexity ≈ (\d+)\), which is typical of human writing\.$/,
    key: tr("The wording is fairly unpredictable (perplexity ≈ {{n}}), which is typical of human writing."),
    params: ["n"],
  },
  {
    re: /^(\d+)% of the words were the language model's single top guess, which is higher than usual for human writing\.$/,
    key: tr("{{percent}}% of the words were the language model's single top guess, which is higher than usual for human writing."),
    params: ["percent"],
  },
  {
    re: /^About (\d+)% of the analysed text sits in paragraphs that individually look machine-written\.$/,
    key: tr("About {{percent}}% of the analysed text sits in paragraphs that individually look machine-written."),
    params: ["percent"],
  },
  {
    re: /^Binoculars score ≈ ([\d.]+), below the ([\d.]+) threshold: relative to how surprising the topic is, the wording is as predictable as a language model's own output\.$/,
    key: tr(
      "Binoculars score ≈ {{score}}, below the {{threshold}} threshold: relative to how surprising the topic is, the wording is as predictable as a language model's own output.",
    ),
    params: ["score", "threshold"],
  },
  {
    re: /^Binoculars score ≈ ([\d.]+), above the ([\d.]+) threshold, which is typical of human writing\.$/,
    key: tr("Binoculars score ≈ {{score}}, above the {{threshold}} threshold, which is typical of human writing."),
    params: ["score", "threshold"],
  },
  {
    re: /^Classifier estimate: (\d+)% human, (\d+)% raw AI, (\d+)% AI-edited, (\d+)% humanized AI text\.$/,
    key: tr("Classifier estimate: {{human}}% human, {{ai}}% raw AI, {{edited}}% AI-edited, {{humanized}}% humanized AI text."),
    params: ["human", "ai", "edited", "humanized"],
  },
];

/** Static sentences from the detector (exact-match catalog keys, no numbers). */
const STATIC_AI_TEXT = [
  tr("Sentence-to-sentence variation is low: the text keeps the same even rhythm throughout, while human writing usually mixes easy and surprising sentences."),
  tr("No strong sign of machine-written text was found in the analysed paragraphs."),
  tr("This detector was calibrated on English; results for other languages are less reliable, so a text is never labelled 'likely' AI-written on this evidence alone."),
  tr("This detector was calibrated on English; results for other languages are less reliable."),
  tr("Not enough running text to analyse (paragraphs under 40 words are skipped)."),
  tr("Not enough evidence to judge: the detector was calibrated on English academic writing, and this text is not English or is too short, so no percentage is shown."),
  tr("Method: Binoculars (two-model cross-perplexity). Its threshold has not yet been calibrated for this model pair, so treat the number as a hint."),
  tr("Method: a fine-tuned AI-text classifier (DeBERTa-v3), trained on English only."),
  tr("Method: VietBinoculars (PhoGPT-4B model pair). Well-known text the model has memorised, such as Wikipedia passages, famous literature or textbook definitions, can be wrongly flagged as AI."),
  tr("This is a statistical estimate, not proof. Edited AI text and very formulaic human writing can be misjudged, so use it as a prompt to review the flagged paragraphs, not as a verdict."),
] as const;

/** Translate one reason/disclaimer sentence from the backend into the UI language. */
export function translateAiText(text: string): string {
  for (const { re, key, params } of REASON_PATTERNS) {
    const match = re.exec(text);
    if (match) {
      const values: Record<string, string> = {};
      params.forEach((name, i) => {
        values[name] = match[i + 1] ?? "";
      });
      return t(key, values);
    }
  }
  return STATIC_AI_TEXT.includes(text as (typeof STATIC_AI_TEXT)[number]) ? t(text) : text;
}

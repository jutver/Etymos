// Per-paragraph "why does this look machine-written" for the AI-content
// section, written in the UI language (t()) from the three numbers
// backend/ai_detector.py measured for the paragraph — so switching VI/EN
// re-renders the explanation, and nothing new has to be stored per language.
//
// Thresholds mirror build_reasons() in ai_detector.py, and the reference
// values ("typical human ≈ 18", "43%") are its CALIBRATION means. Every
// point cites the published method it comes from (AI_DETECTION_SOURCES).
import type { AiDetectionSegment } from "@etymos/shared";
import { currentLocale, t } from "./i18n";

export interface AiDetectionSource {
  /** Shown as [id] after the points that rely on it. */
  id: number;
  /** Author (year). Title. Venue — kept in its original language. */
  citation: string;
  url: string;
}

export const AI_DETECTION_SOURCES: readonly AiDetectionSource[] = [
  {
    id: 1,
    citation:
      "Solaiman, I. et al. (2019). Release Strategies and the Social Impacts of Language Models. OpenAI report, arXiv:1908.09203.",
    url: "https://arxiv.org/abs/1908.09203",
  },
  {
    id: 2,
    citation:
      "Mitchell, E., Lee, Y., Khazatsky, A., Manning, C. D., & Finn, C. (2023). DetectGPT: Zero-Shot Machine-Generated Text Detection using Probability Curvature. ICML 2023.",
    url: "https://arxiv.org/abs/2301.11305",
  },
  {
    id: 3,
    citation:
      "Gehrmann, S., Strobelt, H., & Rush, A. M. (2019). GLTR: Statistical Detection and Visualization of Generated Text. ACL 2019 System Demonstrations.",
    url: "https://arxiv.org/abs/1906.04043",
  },
  {
    id: 4,
    citation:
      "Liang, W., Yuksekgonul, M., Mao, Y., Wu, E., & Zou, J. (2023). GPT detectors are biased against non-native English writers. Patterns, 4(7).",
    url: "https://arxiv.org/abs/2304.02819",
  },
];

export interface AiExplanationPoint {
  text: string;
  /** ids into AI_DETECTION_SOURCES; empty for our own heuristic. */
  sources: number[];
}

// ai_detector.py CALIBRATION: human_mean_nll 2.89 -> perplexity ≈ 18; human top1_frac 0.43.
const TYPICAL_HUMAN_PERPLEXITY = Math.round(Math.exp(2.89));
const TYPICAL_HUMAN_TOP_ONE_PCT = 43;

function fmt(value: number): string {
  return Math.round(value).toLocaleString(currentLocale());
}

/** Plain-language reasons for one paragraph's score, in the UI language. */
export function explainAiSegment(segment: AiDetectionSegment): AiExplanationPoint[] {
  const f = segment.features;
  if (!f) {
    // Report checked before the per-paragraph numbers were stored.
    return [
      {
        text: t("This paragraph scored {{score}}% on the detector's combined measures of how predictable its wording is to a language model.", {
          score: fmt(segment.score),
        }),
        sources: [1, 2, 3],
      },
    ];
  }

  const points: AiExplanationPoint[] = [];
  if (f.meanNll !== undefined) {
    const perplexity = fmt(Math.exp(f.meanNll));
    if (f.meanNll <= 2.4) {
      points.push({
        text: t("The wording is very predictable to a language model (perplexity ≈ {{ppl}}, versus ≈ {{human}} for typical human academic writing); machine-written text tends to pick the most expected word.", {
          ppl: perplexity,
          human: fmt(TYPICAL_HUMAN_PERPLEXITY),
        }),
        sources: [1, 2],
      });
    } else if (f.meanNll >= 3.2) {
      points.push({
        text: t("The wording is fairly unpredictable (perplexity ≈ {{ppl}}), which is typical of human writing.", { ppl: perplexity }),
        sources: [1, 2],
      });
    }
  }
  if (f.topOneShare !== undefined && f.topOneShare >= 0.5) {
    points.push({
      text: t("{{pct}}% of the words were the language model's single top guess, against about {{human}}% in human academic writing.", {
        pct: fmt(f.topOneShare * 100),
        human: fmt(TYPICAL_HUMAN_TOP_ONE_PCT),
      }),
      sources: [3],
    });
  }
  if (f.sentenceSpread !== undefined && f.sentenceSpread <= 0.6) {
    points.push({
      text: t("Its sentences keep the same even rhythm, while human writing usually mixes easy and surprising sentences."),
      sources: [],
    });
  }
  if (points.length === 0) {
    points.push({
      text: t("No single measure stands out; the score comes from the three measures together."),
      sources: [1, 2, 3],
    });
  }
  return points;
}

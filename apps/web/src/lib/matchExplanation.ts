// "Why this is flagged" for a matched source, in the UI language.
//
// The backend (ai_explain.py) writes the explanation in the *student's*
// language and also sends `explanation_facts`: which template it used and the
// values it filled in. Rebuilding the sentence here with t() means switching
// VI/EN changes the explanation instantly. Templates mirror ai_explain._TEXT.
// Without facts (LLM-written text, older reports) the stored text is shown.
import type { MatchedSource, MatchExplanationFacts } from "@etymos/shared";
import { t } from "./i18n";

const KINDS: readonly MatchExplanationFacts["kind"][] = ["identical", "definition_only", "whole", "verbatim", "phrase", "reworded"];

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Tolerant parse of the backend's `explanation_facts` JSON; anything unexpected -> undefined. */
export function parseExplanationFacts(raw: unknown): MatchExplanationFacts | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (!KINDS.includes(r.kind as MatchExplanationFacts["kind"])) return undefined;
  return {
    kind: r.kind as MatchExplanationFacts["kind"],
    label: typeof r.label === "string" ? r.label : "",
    title: typeof r.title === "string" ? r.title : "",
    shared: num(r.shared),
    total: num(r.total),
    phrase: typeof r.phrase === "string" ? r.phrase : "",
    semantic: num(r.semantic),
  };
}

function suffix(label: string): string {
  if (label === "common_academic_definition") {
    return t("This looks like a standard definition that many authors phrase similarly; it is usually acceptable if you cite where the definition comes from.");
  }
  if (label === "likely_plagiarism") return t("It is among the strongest matches in your document.");
  if (label === "suspicious") return t("It deserves a closer look.");
  return "";
}

function body(f: MatchExplanationFacts): string {
  const title = f.title ? ` "${f.title}"` : "";
  const values = { title, shared: f.shared, total: f.total, phrase: f.phrase, semantic: f.semantic };
  switch (f.kind) {
    case "identical":
      return t("This sentence is identical to the source{{title}}: every word matches, so it reads as copied word for word. If you want to keep it, put it in quotation marks and cite the source; otherwise say the idea in your own words and structure.", values);
    case "whole":
      return t("Almost this whole sentence appears in the source{{title}} in the same words ({{shared}} of your {{total}} words in a row). That reads as direct copying. Quote and cite it, or restate the idea in your own words.", values);
    case "verbatim":
      return t("Your text shares a {{shared}}-word run with the source{{title}}: \"{{phrase}}\". Reusing that many words in a row is a strong sign of direct copying, so quote and cite it or reword it.", values);
    case "phrase":
      return t("Your text and the source{{title}} share the phrase \"{{phrase}}\" ({{shared}} words in a row), and the sentence as a whole is {{semantic}}% similar in meaning. Reword the surrounding sentence, or quote and cite the source.", values);
    case "reworded":
      return t("The wording differs from the source{{title}}, but the meaning is {{semantic}}% the same and the sentence follows the source's structure. Close paraphrases like this are still flagged: restructure the sentence in your own way and cite the source.", values);
    case "definition_only":
      return t("({{semantic}}% similar in meaning to the source{{title}}.)", values);
  }
}

// --- Reports saved before `explanation_facts` existed ----------------------
// Their stored explanation was still written from ai_explain._TEXT, so the
// facts can be read back out of the sentence. Templates copied verbatim from
// ai_explain.py (both languages, {title} = ' "Title"' or "").
const STORED_TEMPLATES: Record<Exclude<MatchExplanationFacts["kind"], "definition_only">, string[]> = {
  identical: [
    "This sentence is identical to the source{title}: every word matches, so it reads as copied word for word. If you want to keep it, put it in quotation marks and cite the source; otherwise say the idea in your own words and structure.",
    "Câu này giống hệt nguồn{title}: từng từ đều trùng, nên đọc lên như sao chép nguyên văn. Nếu muốn giữ, hãy đặt trong dấu ngoặc kép và trích dẫn nguồn; nếu không, hãy diễn đạt lại ý bằng lời và cấu trúc của bạn.",
  ],
  whole: [
    "Almost this whole sentence appears in the source{title} in the same words ({shared} of your {total} words in a row). That reads as direct copying. Quote and cite it, or restate the idea in your own words.",
    "Gần như cả câu này xuất hiện trong nguồn{title} với đúng từ ngữ ({shared}/{total} từ liên tiếp trùng nhau). Đây là dấu hiệu sao chép trực tiếp. Hãy trích dẫn nguyên văn kèm nguồn, hoặc diễn đạt lại ý bằng lời của bạn.",
  ],
  verbatim: [
    "Your text shares a {shared}-word run with the source{title}: \"{phrase}\". Reusing that many words in a row is a strong sign of direct copying, so quote and cite it or reword it.",
    "Văn bản của bạn trùng với nguồn{title} một đoạn dài {shared} từ liên tiếp: \"{phrase}\". Trùng nhiều từ liền nhau như vậy là dấu hiệu mạnh của việc sao chép, hãy trích dẫn kèm nguồn hoặc viết lại.",
  ],
  phrase: [
    "Your text and the source{title} share the phrase \"{phrase}\" ({shared} words in a row), and the sentence as a whole is {semantic}% similar in meaning. Reword the surrounding sentence, or quote and cite the source.",
    "Văn bản của bạn và nguồn{title} có chung cụm \"{phrase}\" ({shared} từ liên tiếp), và toàn câu giống nhau {semantic}% về nghĩa. Hãy viết lại phần câu xung quanh, hoặc trích dẫn kèm nguồn.",
  ],
  reworded: [
    "The wording differs from the source{title}, but the meaning is {semantic}% the same and the sentence follows the source's structure. Close paraphrases like this are still flagged: restructure the sentence in your own way and cite the source.",
    "Từ ngữ khác với nguồn{title}, nhưng ý nghĩa giống {semantic}% và câu đi theo đúng cấu trúc của nguồn. Kiểu diễn đạt lại sát như vậy vẫn bị đánh dấu: hãy tổ chức lại câu theo cách riêng của bạn và trích dẫn nguồn.",
  ],
};
const STORED_SUFFIXES: [string, string][] = [
  ["common_academic_definition", " This looks like a standard definition that many authors phrase similarly; it is usually acceptable if you cite where the definition comes from."],
  ["common_academic_definition", " Đây có vẻ là một định nghĩa quen thuộc mà nhiều tác giả diễn đạt tương tự; thường vẫn chấp nhận được nếu bạn ghi rõ nguồn của định nghĩa."],
  ["likely_plagiarism", " It is among the strongest matches in your document."],
  ["likely_plagiarism", " Đây là một trong những đoạn trùng đáng chú ý nhất trong tài liệu của bạn."],
  ["suspicious", " It deserves a closer look."],
  ["suspicious", " Cần xem xét kỹ hơn."],
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Template -> regex with named groups; {title} is optional. */
function templateRegex(template: string): RegExp {
  const pattern = escapeRe(template)
    .replace("\\{title\\}", '(?: "(?<title>.*?)")?')
    .replace("\\{shared\\}", "(?<shared>\\d+)")
    .replace("\\{total\\}", "(?<total>\\d+)")
    .replace("\\{semantic\\}", "(?<semantic>\\d+)")
    .replace("\\{phrase\\}", "(?<phrase>.*?)");
  return new RegExp(`^${pattern}$`, "s");
}

const STORED_REGEXES = (Object.entries(STORED_TEMPLATES) as [keyof typeof STORED_TEMPLATES, string[]][]).flatMap(
  ([kind, templates]) => templates.map((template) => ({ kind, re: templateRegex(template) })),
);
// facts_explanation()'s definition-only branch is English-only in ai_explain.py.
const STORED_DEFINITION_ONLY = new RegExp(
  `^${escapeRe(STORED_SUFFIXES[0][1].trim())} \\((?<semantic>\\d+)% similar in meaning(?: to "(?<title>.*)")?\\.\\)$`,
  "s",
);

/** Facts recovered from an explanation stored as text; undefined for LLM / unknown text. */
export function factsFromStoredText(text: string | undefined): MatchExplanationFacts | undefined {
  const stored = (text ?? "").trim();
  if (!stored) return undefined;

  const definition = STORED_DEFINITION_ONLY.exec(stored);
  if (definition?.groups) {
    return {
      kind: "definition_only", label: "common_academic_definition", title: definition.groups.title ?? "",
      shared: 0, total: 0, phrase: "", semantic: num(definition.groups.semantic),
    };
  }

  let label = "";
  let body = stored;
  for (const [suffixLabel, suffixText] of STORED_SUFFIXES) {
    if (stored.endsWith(suffixText.trim()) && stored.length > suffixText.trim().length) {
      label = suffixLabel;
      body = stored.slice(0, stored.length - suffixText.trim().length).trimEnd();
      break;
    }
  }
  for (const { kind, re } of STORED_REGEXES) {
    const m = re.exec(body);
    if (!m) continue;
    const g = m.groups ?? {};
    return {
      kind, label, title: g.title ?? "", shared: num(g.shared), total: num(g.total), phrase: g.phrase ?? "", semantic: num(g.semantic),
    };
  }
  return undefined;
}

/** The explanation to show for `match`, in the current UI language when possible. */
export function explainMatch(match: MatchedSource): string {
  const f = match.explanationFacts ?? factsFromStoredText(match.explanation);
  if (!f) return match.explanation;
  if (f.kind === "definition_only") return `${suffix("common_academic_definition")} ${body(f)}`;
  return [body(f), suffix(f.label)].filter(Boolean).join(" ");
}

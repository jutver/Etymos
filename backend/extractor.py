import fitz
import logging
import re
from collections import Counter

logger = logging.getLogger(__name__)


ROMAN = {"I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"}


def clean_text(text):
    text = text.replace("￾", "")
    text = text.replace("—", " ")
    text = text.replace("-\n", "")
    text = " ".join(text.split())
    return text.strip()


def is_heavy_math_line(text):
    """
    Nhận diện các dòng chứa công thức toán học hoặc số thứ tự phương trình.
    """
    text_strip = text.strip()
    if not text_strip:
        return True

    # 1. Bắt các dòng chỉ chứa đánh số phương trình, vd: "(1)", "(12)", "(3a)"
    if re.fullmatch(r'\(\d+[a-zA-Z]*\)', text_strip):
        return True

    # 2. Tập hợp các ký hiệu toán học phổ biến (bao gồm cả dấu ⊕ trong bài của bro)
    # Dấu gạch nối ASCII "-" cố ý KHÔNG nằm trong tập này: trong văn xuôi nó là
    # gạch nối từ ghép ("text-to-text", "state-of-the-art") hoặc dấu ngắt dòng
    # ("architec-"). Tính nó là ký hiệu toán khiến 1 dòng chữ thường có 3 gạch nối
    # bị coi là phương trình và bị vứt cả dòng (mất chữ giữa câu). Dấu trừ thật
    # là "−" (Unicode) hoặc " - " đứng riêng giữa hai toán hạng.
    math_symbols = set("=+×÷±∈∉∑∏∫≈≠≤≥∝∞∇∂⊕⊗−")
    symbol_count = sum(1 for c in text if c in math_symbols)
    symbol_count += len(re.findall(r"(?<=\s)-(?=\s)", text))

    # Nếu 1 dòng ngắn hoặc vừa mà có từ 3-4 ký hiệu toán học trở lên -> Chắc chắn là phương trình
    if symbol_count >= 3:
        return True

    # Đuôi trích dẫn bị ngắt dòng ("et al. , 2022 ).") ít chữ cái nhưng là văn xuôi,
    # vứt nó làm hỏng câu chứa trích dẫn.
    if re.search(r"\bet\s+al\b", text, re.IGNORECASE):
        return False

    # 3. Heuristic dựa trên tỷ lệ chữ cái
    # Dòng text bình thường sẽ có mật độ chữ cái (a-z) rất cao.
    # Công thức toán thường chứa nhiều khoảng trắng, ngoặc, số, và ký tự rời rạc.
    alpha_count = sum(1 for c in text if c.isalpha())
    total_chars = len(text.replace(" ", ""))

    # Dòng không có chữ cái nào ("-", "1", "( )") là ký tự lạc/số trang, không phải văn xuôi.
    if alpha_count == 0:
        return True

    if total_chars > 0:
        # Nếu chưa tới 50% số ký tự là chữ cái, và có chứa toán học/số -> Loại bỏ
        if alpha_count / total_chars < 0.5 and (symbol_count > 0 or any(c.isdigit() for c in text)):
            return True

    return False


ITALIC_FONT_TOKENS = ("italic", "oblique", "cmti", "cmmi", "-it", "_it")


def _span_is_bold(span):
    if span.get("flags", 0) & 16:
        return True
    font = (span.get("font") or "").lower()
    return any(token in font for token in ("bold", "medi", "semibold", "black", "heavy", "cmbx"))


def _span_is_italic(span):
    # PyMuPDF span flag bit 1 (value 2) = italic.
    if span.get("flags", 0) & 2:
        return True
    font = (span.get("font") or "").lower()
    return any(token in font for token in ITALIC_FONT_TOKENS)


def compute_text_marks(pieces, joiner, target_text):
    """
    Inline bold/italic ranges of `target_text`, as
    [{"start": int, "end": int, "style": "bold" | "italic"}] with offsets
    into `target_text` - which is exactly the block text that ends up in the
    canonical document, so a block's marks are relative to its start.

    `pieces` is the styled source text [(text, bold, italic), ...] that was
    joined with `joiner` and passed through clean_text() to produce the
    block text (PDF: spans joined with " "; DOCX: runs joined with "").
    The same clean_text() steps are replayed character by character so each
    character keeps its style. A list item whose marker was stripped off
    the front is matched as a suffix. If the replay doesn't reproduce the
    text, no marks are returned - never marks at the wrong place.
    """
    if not target_text or not pieces:
        return []
    if not any(bold or italic for _, bold, italic in pieces):
        return []

    chars = []
    first = True
    for text, bold, italic in pieces:
        if not text:
            continue
        if not first and joiner:
            chars.extend((c, False, False) for c in joiner)
        first = False
        chars.extend((c, bool(bold), bool(italic)) for c in text)

    # Same order as clean_text().
    chars = [ch for ch in chars if ch[0] != "￾"]
    chars = [(" " if c == "—" else c, b, i) for c, b, i in chars]
    dehyphenated = []
    k = 0
    while k < len(chars):
        if chars[k][0] == "-" and k + 1 < len(chars) and chars[k + 1][0] == "\n":
            k += 2
            continue
        dehyphenated.append(chars[k])
        k += 1
    collapsed = []
    for c, b, i in dehyphenated:
        if c.isspace():
            if collapsed and collapsed[-1][0] == " ":
                continue
            collapsed.append((" ", b, i))
        else:
            collapsed.append((c, b, i))
    while collapsed and collapsed[0][0] == " ":
        collapsed.pop(0)
    while collapsed and collapsed[-1][0] == " ":
        collapsed.pop()

    replayed = "".join(c for c, _, _ in collapsed)
    if replayed == target_text:
        offset = 0
    elif replayed.endswith(target_text):
        offset = len(replayed) - len(target_text)
    else:
        return []
    styled = collapsed[offset:]

    marks = []
    for style, index in (("bold", 1), ("italic", 2)):
        flags = [ch[index] for ch in styled]
        # A space between two styled words (the " " that joined two bold
        # spans) belongs to the styled run, so "two bold words" is one mark.
        for pos, ch in enumerate(styled):
            if ch[0] == " " and not flags[pos]:
                left = pos > 0 and flags[pos - 1]
                right = pos + 1 < len(flags) and flags[pos + 1]
                if left and right:
                    flags[pos] = True
        start = None
        for pos, on in enumerate(flags + [False]):
            if on and start is None:
                start = pos
            elif not on and start is not None:
                marks.append({"start": start, "end": pos, "style": style})
                start = None
    return marks


def extract_lines_from_pdf(pdf_path):
    doc = fitz.open(pdf_path)
    lines = []

    for page_idx, page in enumerate(doc):
        data = page.get_text("dict")

        for block in data.get("blocks", []):
            for line in block.get("lines", []):
                texts, sizes, fonts = [], [], []
                bold_flags = []
                styled_spans = []

                for span in line.get("spans", []):
                    text = span.get("text", "").strip()
                    if text:
                        texts.append(text)
                        sizes.append(span.get("size", 0))
                        fonts.append(span.get("font", ""))
                        # PyMuPDF span flag bit 4 (value 16) = bold.
                        bold_flags.append(bool(span.get("flags", 0) & 16))
                        styled_spans.append((
                            text,
                            _span_is_bold(span),
                            _span_is_italic(span),
                        ))

                line_text = " ".join(texts).strip()

                if line_text and sizes:
                    lines.append({
                        "text": line_text,
                        "page": page_idx + 1,
                        "size": max(sizes),
                        "font": " ".join(fonts),
                        "words": len(line_text.split()),
                        # True when every text span on the line is bold -
                        # used by classify_block_type() to recognise
                        # numbered headings set in body size but bold.
                        "bold": bool(bold_flags) and all(bold_flags),
                        # (text, bold, italic) per span, joined by " " exactly
                        # like "text" above - lets build_structured_blocks()
                        # keep inline bold/italic as block "marks".
                        "spans": styled_spans,
                    })

    return lines


def get_body_font_size(lines):
    sizes = [
        round(line["size"], 1)
        for line in lines
        if line["words"] >= 5
    ]

    if not sizes:
        return 10.0

    return Counter(sizes).most_common(1)[0][0]


def normalize_heading_text(text):
    text = text.replace("￾", "")
    text = " ".join(text.split())

    replacements = {
        "I NTRODUCTION": "INTRODUCTION",
        "R ELATED W ORK": "RELATED WORK",
        "P ROPOSED M ETHODOLOGY": "PROPOSED METHODOLOGY",
        "P ROPOSED M ETHOD": "PROPOSED METHOD",
        "M ETHODOLOGY": "METHODOLOGY",
        "E XPERIMENTAL S ETUP": "EXPERIMENTAL SETUP",
        "E XPERIMENTS": "EXPERIMENTS",
        "R ESULTS AND D ISCUSSION": "RESULTS AND DISCUSSION",
        "C ONCLUSION AND F UTURE W ORK": "CONCLUSION AND FUTURE WORK",
        "C ONCLUSION": "CONCLUSION",
        "R EFERENCES": "REFERENCES",
    }

    for bad, good in replacements.items():
        text = text.replace(bad, good)

    return text.strip()


def is_major_marker(token):
    token = token.strip().replace(".", "").upper()

    if token in ROMAN:
        return True

    if token.isdigit():
        n = int(token)
        return 1 <= n <= 20

    return False


def strip_major_marker(text):
    parts = text.split()

    if parts and is_major_marker(parts[0]):
        return " ".join(parts[1:]).strip()

    return text.strip()


def compact_heading(text):
    text = normalize_heading_text(text)
    text = strip_major_marker(text)
    text = text.lower()
    for ch in [".", ":", "-", "—", "_"]:
        text = text.replace(ch, "")
    return "".join(text.split())


def section_from_heading(text):
    raw = normalize_heading_text(text)
    compact = compact_heading(raw)

    if raw.lower().startswith("abstract"):
        return "abstract"

    mapping = {
        "introduction": "introduction",

        "relatedwork": "related_work",
        "background": "related_work",
        "literaturereview": "related_work",

        "method": "method",
        "methods": "method",
        "methodology": "method",
        "proposedmethod": "method",
        "proposedmethodology": "method",
        "approach": "method",
        "framework": "method",
        "modelarchitecture": "method",
        "systemarchitecture": "method",

        "experiment": "experiment",
        "experiments": "experiment",
        "experimentsandresults": "experiment",
        "experimentalsetup": "experiment",
        "evaluation": "experiment",
        "evaluationmetrics": "experiment",

        "result": "result",
        "results": "result",
        "resultsanddiscussion": "result",
        "discussion": "result",

        "conclusion": "conclusion",
        "conclusions": "conclusion",
        "conclusionandfuturework": "conclusion",

        "references": "references",
        "bibliography": "references",
    }

    return mapping.get(compact)


def extract_inline_abstract(text):
    text = normalize_heading_text(text)

    if not text.lower().startswith("abstract"):
        return ""

    for sep in ["—", "-", ":"]:
        if sep in text:
            return text.split(sep, 1)[1].strip()

    if text.lower() == "abstract":
        return ""

    parts = text.split(maxsplit=1)
    return parts[1].strip() if len(parts) > 1 else ""


def is_table_or_equation_like(text):
    lower = text.lower()
    parts = text.split()

    if not parts:
        return True

    first = parts[0].replace(".", "")

    if first.isdigit() and int(first) > 20:
        return True

    table_words = [
        "batch size",
        "learning rate",
        "warmup ratio",
        "dropout rate",
        "optimizer",
        "accuracy",
        "macro f1",
        "precision",
        "recall",
        "rouge",
        "bleu",
        "number of epochs",
        "weight decay",
        "max sequence length",
    ]

    if any(w in lower for w in table_words):
        return True

    if any(symbol in text for symbol in ["=", "∈", "×", "≤", "≥"]):
        return True

    return False


def is_probable_title_or_author(line, body_size):
    text = line["text"]
    lower = text.strip().lower()

    if lower == "abstract" or lower.startswith("abstract "):
        return False

    if line["page"] == 1 and line["size"] > body_size + 2:
        return True

    if "@" in text:
        return True

    if line["page"] == 1 and line["words"] <= 5 and line["size"] >= body_size:
        first = text.split()[0] if text.split() else ""

        if not is_major_marker(first) and lower != "abstract":
            return True

    return False


def is_valid_major_heading(text):
    text = normalize_heading_text(text)
    parts = text.split()

    if not parts:
        return False

    first = parts[0]

    if not is_major_marker(first):
        return False

    rest = strip_major_marker(text)

    if not rest:
        return False

    rest_lower = rest.lower()

    if (
        "http://" in rest_lower
        or "https://" in rest_lower
        or "www." in rest_lower
        or rest_lower.startswith("doi")
    ):
        return False

    if is_table_or_equation_like(rest):
        return False

    if len(rest.split()) > 10:
        return False

    return True

def is_valid_plain_heading(text):
    text = normalize_heading_text(text)
    section = section_from_heading(text)

    if not section:
        return False

    if len(text.split()) > 8:
        return False

    compact = compact_heading(text)

    allowed_compacts = {
        "abstract",
        "introduction",
        "relatedwork",
        "background",
        "literaturereview",
        "method",
        "methods",
        "methodology",
        "proposedmethod",
        "proposedmethodology",
        "approach",
        "framework",
        "modelarchitecture",
        "experimentalsetup",
        "experiment",
        "experiments",
        "experimentsandresults",
        "evaluation",
        "evaluationmetrics",
        "result",
        "results",
        "resultsanddiscussion",
        "discussion",
        "conclusion",
        "conclusions",
        "conclusionandfuturework",
        "references",
        "bibliography",
    }

    return compact in allowed_compacts or text.lower().startswith("abstract")

def build_chunks_from_sections(
    sections,
    paper_id="input_paper",
    chunk_size=900,
    overlap=150,
    section_offsets=None
):
    """
    Split each section into overlapping chunks.

    `section_offsets` (optional) maps a section name to the start offset
    of that section's stripped text inside the canonical document string
    built by document_model.build_document(). When supplied, every chunk
    also carries `doc_start_char` / `doc_end_char`: absolute character
    offsets into `report["input_text"]`. These are what let the matcher
    report the true span of a match instead of an approximation.

    `start_char` / `end_char` remain section-relative, as before, and are
    now exact: the leading/trailing whitespace stripped off `chunk_text`
    is accounted for, so `text[start_char:end_char] == chunk_text`.
    """
    chunks = []
    section_offsets = section_offsets or {}

    for section_name, section_text in sections.items():
        if section_name == "title":
            continue

        if not section_text or len(section_text.strip()) < 50:
            continue

        start = 0
        text = section_text.strip()
        base = section_offsets.get(section_name)

        while start < len(text):
            end = min(start + chunk_size, len(text))
            raw = text[start:end]
            chunk_text = raw.strip()

            if len(chunk_text) >= 80:
                lead = len(raw) - len(raw.lstrip())
                exact_start = start + lead
                exact_end = exact_start + len(chunk_text)

                chunk = {
                    "paper_id": paper_id,
                    "section": section_name,
                    "chunk_id": f"{paper_id}_{section_name}_{len(chunks)}",
                    "start_char": exact_start,
                    "end_char": exact_end,
                    "text": chunk_text
                }

                if base is not None:
                    chunk["doc_start_char"] = base + exact_start
                    chunk["doc_end_char"] = base + exact_end

                chunks.append(chunk)

            start += chunk_size - overlap

    return chunks

def build_heading_candidates(lines):
    body_size = get_body_font_size(lines)
    raw_candidates = []
    seen = set()

    for i, line in enumerate(lines):
        text = normalize_heading_text(line["text"]).strip()

        if not text:
            continue

        if is_table_or_equation_like(text):
            continue

        if is_probable_title_or_author(line, body_size):
            continue

        candidate = None

        if text.lower().startswith("abstract"):
            candidate = {
                "index": i,
                "text": "Abstract",
                "section": "abstract",
                "inline_content": extract_inline_abstract(text),
                "level": "major"
            }

        elif is_valid_major_heading(text):
            section = section_from_heading(text) or "unknown"
            candidate = {
                "index": i,
                "text": text,
                "section": section,
                "inline_content": "",
                "level": "major"
            }

        elif is_major_marker(text) and i + 1 < len(lines):
            next_text = normalize_heading_text(lines[i + 1]["text"]).strip()
            combined = f"{text} {next_text}"

            if is_valid_major_heading(combined):
                section = section_from_heading(combined) or "unknown"
                candidate = {
                    "index": i,
                    "second_index": i + 1,
                    "text": combined,
                    "section": section,
                    "inline_content": "",
                    "level": "major"
                }

        elif is_valid_plain_heading(text):
            candidate = {
                "index": i,
                "text": text,
                "section": section_from_heading(text),
                "inline_content": "",
                "level": "plain"
            }

        if candidate:
            key = f"{candidate['index']}::{candidate['text'].lower()}"

            if key not in seen:
                seen.add(key)
                raw_candidates.append(candidate)

    return filter_and_fix_headings(raw_candidates)


def filter_and_fix_headings(candidates):
    candidates = sorted(candidates, key=lambda x: x["index"])

    has_major = any(c["level"] == "major" for c in candidates)
    filtered = []

    for c in candidates:
        if has_major and c["level"] == "plain":
            if c["section"] == "references":
                filtered.append(c)
            continue

        filtered.append(c)

    for i, c in enumerate(filtered):
        if c["section"] != "unknown":
            continue

        prev_section = None
        next_section = None

        for j in range(i - 1, -1, -1):
            if filtered[j]["section"] not in ["unknown", "abstract"]:
                prev_section = filtered[j]["section"]
                break

        for j in range(i + 1, len(filtered)):
            if filtered[j]["section"] not in ["unknown"]:
                next_section = filtered[j]["section"]
                break

        rest = strip_major_marker(c["text"])

        if prev_section in ["introduction", "related_work"] and next_section in [
            "experiment",
            "result",
            "conclusion",
            "references"
        ]:
            if not (
                "http://" in rest.lower()
                or "https://" in rest.lower()
                or "www." in rest.lower()
            ):
                c["section"] = "method"

    for c in filtered:
        if c["section"] == "result":
            c["section"] = "experiment"

    filtered = [c for c in filtered if c["section"] != "unknown"]

    final = []
    seen_pairs = set()

    for c in filtered:
        key = (c["section"], c["text"].lower())

        if key in seen_pairs:
            continue

        seen_pairs.add(key)
        final.append(c)

    return final


def classify_heading_candidates(candidates, heading_labels=None):
    classified = []

    for c in candidates:
        section = c.get("section") or section_from_heading(c["text"])

        if not section or section == "unknown":
            continue

        classified.append({
            "index": c["index"],
            "second_index": c.get("second_index"),
            "text": c["text"],
            "section": section,
            "inline_content": c.get("inline_content", "")
        })

    return classified


def extract_title_from_lines(lines):
    if not lines:
        return ""

    body_size = get_body_font_size(lines)
    title_lines = []

    for line in lines[:25]:
        text = line["text"]
        lower = text.lower()

        if lower.startswith("abstract") or "introduction" in lower:
            break

        if line["size"] > body_size + 2 and line["words"] >= 3:
            title_lines.append(text)

    return clean_text(" ".join(title_lines))


LIST_MARKER_RE = re.compile(
    r'^(?:[•‣◦●○▪▫•●▪\-\*]|\(?\d{1,3}[\.\)]|\(?[a-zA-Z][\.\)])\s+'
)
BULLET_MARKER_CHARS = set("•‣◦●○▪▫-*•●▪")

# Numbered headings as they appear in the original document:
#   "2.1 Dataset", "3.2.1 Training Details"  -> sub-section (level 3)
#   "4 Proposed Model", "IV. RESULTS"         -> section (level 2)
# Only trusted when the line is also bold (see _looks_bold), so a wrapped
# body line such as "0.5 M NaCl was added..." never turns into a heading.
SUBSECTION_HEADING_RE = re.compile(r'^[1-9]\d?(?:\.\d{1,2}){1,2}\.?\s+[A-Z]')
NUMBERED_SECTION_HEADING_RE = re.compile(r'^(?:[1-9]\d?\.?|[IVX]{1,4}\.)\s+[A-Z]')
# The words after a heading's number: a sentence break inside them means a
# run-in heading followed by body text ("3.2.5. Dataset splitting. The ...").
HEADING_NUMBER_PREFIX_RE = re.compile(r'^(?:[1-9]\d?(?:\.\d{1,2}){0,2}|[IVX]{1,4})\.?\s+')


def _is_clean_heading_rest(text):
    rest = HEADING_NUMBER_PREFIX_RE.sub("", text, count=1)
    return ". " not in rest
BOLD_FONT_TOKENS = ("bold", "medi", "semibold", "black", "heavy", "cmbx")


# Unnumbered parts papers put around the end (ACL/IEEE/Springer/PLOS...).
# They are usually bold at (or barely above) body size, so neither the
# font-size rule nor the numbered-heading rule below catches them.
UNNUMBERED_PART_HEADINGS = {
    "limitation", "limitations",
    "acknowledgement", "acknowledgements", "acknowledgment", "acknowledgments",
    "ethics statement", "ethical statement", "ethical statements",
    "ethical considerations", "ethics", "broader impact", "broader impacts",
    "impact statement", "conflict of interest", "conflicts of interest",
    "competing interests", "funding", "data availability",
    "data availability statement", "code availability", "author contributions",
    "declarations", "supplementary material", "supplementary materials",
    "supporting information", "appendix", "appendices",
    "lời cảm ơn", "hạn chế", "phụ lục",
}


def _unnumbered_part_name(text):
    name = normalize_heading_text(text).lower().rstrip(".:").strip()
    return name if name in UNNUMBERED_PART_HEADINGS else None


def _looks_bold(line):
    if line.get("bold"):
        return True
    font = (line.get("font") or "").lower()
    return any(token in font for token in BOLD_FONT_TOKENS)

# Section catch-all label, used for any block whose home is the extraction
# fallback described in extract_structured_sections_from_pdf() below rather
# than one of the seven recognized academic-paper buckets.
FALLBACK_SECTION = "body"


def classify_block_type(line, body_size):
    """
    Classify one extracted PDF line for the Document-view renderer.

    Returns (block_type, level, list_type, text):
      - ("heading", 1|2|3, None, text)         font meaningfully > body size
      - ("list_item", None, "bullet"|"number", text)  leading bullet/numeral
      - ("paragraph", None, None, text)        everything else

    This is independent of (and much looser than) build_heading_candidates()
    above, which only recognizes the numbered/roman/academic-vocabulary
    headings needed to slot content into the fixed section taxonomy. This
    classifier runs over EVERY line (including ones already inside a
    recognized section, and every line in the "body" fallback) purely to
    give the Document view real <h1>/<h2>/<h3>/<ul>/<ol> structure instead
    of one flat paragraph.
    """
    text = line["text"].strip()
    size = line.get("size", body_size) or body_size
    word_count = len(text.split())

    # "Limitations", "Acknowledgement", "Ethical Statements"... standing on
    # their own line, set bold or at least body size: a top-level part.
    if _unnumbered_part_name(text) and (_looks_bold(line) or size >= body_size - 0.5):
        return "heading", 2, None, text

    if size >= body_size + 5 and word_count <= 20:
        return "heading", 1, None, text
    if size >= body_size + 2.5 and word_count <= 20:
        return "heading", 2, None, text
    if size >= body_size + 1 and word_count <= 16:
        return "heading", 3, None, text

    # A short, fully bold line a bit larger than the text (11.95pt over an
    # 11pt body) is an unnumbered heading. Table cells are bold too, but
    # set smaller than the body, so the size floor keeps them out.
    if (
        _looks_bold(line)
        and size >= body_size + 0.5
        and word_count <= 16
        and not text.endswith((".", ",", ";"))
        and text[:1].isupper()
    ):
        return "heading", 3, None, text

    if (
        word_count <= 12
        and not text.endswith((".", ",", ";"))
        and _looks_bold(line)
        and _is_clean_heading_rest(text)
    ):
        if SUBSECTION_HEADING_RE.match(text):
            return "heading", 3, None, text
        if NUMBERED_SECTION_HEADING_RE.match(text) and word_count <= 10:
            return "heading", 2, None, text

    marker = LIST_MARKER_RE.match(text)
    if marker:
        stripped = text[marker.end():].strip()
        if stripped:
            marker_text = marker.group(0).strip()
            list_type = "bullet" if marker_text[:1] in BULLET_MARKER_CHARS else "number"
            return "list_item", None, list_type, stripped

    return "paragraph", None, None, text


def _block_marks(source_lines, block_text):
    pieces = [piece for line in source_lines for piece in (line.get("spans") or [])]
    try:
        return compute_text_marks(pieces, " ", block_text)
    except Exception:
        logger.exception("Could not compute inline marks for a block; rendering it plain.")
        return []


def build_structured_blocks(section_lines, body_size):
    """
    Turn a list of raw line dicts (already stripped of equation/junk lines)
    into merged structural blocks: consecutive paragraph lines are merged
    into one paragraph block (the natural line-wrap of a PDF), while every
    heading or list line becomes its own block.

    Returns a list of {"type", "level", "list_type", "text", "page"} dicts.
    """
    blocks = []
    current = None

    def flush():
        nonlocal current
        if current is not None:
            cleaned = clean_text(current["text"])
            source_lines = current.pop("_lines", [])
            if cleaned:
                current["text"] = cleaned
                marks = _block_marks(source_lines, cleaned)
                if marks:
                    current["marks"] = marks
                blocks.append(current)
        current = None

    for line in section_lines:
        btype, level, list_type, raw_text = classify_block_type(line, body_size)
        text = clean_text(raw_text)
        if not text:
            continue

        if btype == "paragraph":
            if current is not None and current["type"] == "paragraph":
                current["text"] = current["text"] + " " + text
                current["_lines"].append(line)
            else:
                flush()
                current = {
                    "type": "paragraph", "level": None, "list_type": None,
                    "text": text, "page": line["page"],
                    "_lines": [line],
                }
        else:
            flush()
            block = {
                "type": btype, "level": level, "list_type": list_type,
                "text": text, "page": line["page"],
            }
            if btype == "list_item":
                marks = _block_marks([line], text)
                if marks:
                    block["marks"] = marks
            else:
                # Headings keep their marks too: a line read as a heading
                # can later be shown as a plain paragraph
                # (_front_matter_blocks, _enforce_heading_sequence), and
                # its bold words must then still be bold.
                marks = _block_marks([line], text)
                if marks:
                    block["marks"] = marks
            blocks.append(block)

    flush()
    return blocks


def extract_pdf_images(pdf_path):
    """
    Best-effort raster-image extraction per PDF page, for the Document
    view's "image" blocks. Returns {page_number (1-based): [block, ...]}
    where each block is {"type": "image", "level": None, "list_type":
    None, "text": "", "page": N, "_image_bytes": bytes, "_image_ext": str}.

    `_image_bytes` / `_image_ext` are an in-process-only carrier consumed
    by report_store._extract_and_upload_images (turned into a Storage
    `image_url` and stripped before the report is persisted/returned) —
    they are never meant to reach a JSON response as-is.

    Uses fitz.Pixmap per xref (page.get_images(full=True) returns xref
    ids, not bytes) rather than page.get_image_info(), which only reports
    geometry. Never raises: any page/xref PyMuPDF can't materialize is
    skipped — image extraction is additive and must never break the core
    text-extraction pipeline this module also implements.
    """
    images_by_page = {}
    try:
        doc = fitz.open(pdf_path)
    except Exception:
        logger.exception("Failed to open PDF for image extraction: %s", pdf_path)
        return images_by_page

    try:
        for page_idx, page in enumerate(doc):
            page_number = page_idx + 1
            try:
                image_list = page.get_images(full=True)
            except Exception:
                logger.exception("Failed to list images on PDF page %d", page_number)
                continue

            seen_xrefs = set()
            for img in image_list:
                xref = img[0]
                if xref in seen_xrefs:
                    continue
                seen_xrefs.add(xref)

                pixmap = None
                try:
                    pixmap = fitz.Pixmap(doc, xref)
                    if pixmap.colorspace is None:
                        # Stencil/mask image with no colour data of its own —
                        # nothing meaningful to render standalone.
                        continue
                    if pixmap.n - pixmap.alpha >= 4:
                        # CMYK (or similar) — PNG encoding needs RGB/gray.
                        pixmap = fitz.Pixmap(fitz.csRGB, pixmap)
                    image_bytes = pixmap.tobytes("png")
                except Exception:
                    logger.exception(
                        "Failed to materialize PDF image xref=%s on page %d", xref, page_number
                    )
                    continue
                finally:
                    if pixmap is not None:
                        pixmap = None

                if not image_bytes:
                    continue

                images_by_page.setdefault(page_number, []).append({
                    "type": "image", "level": None, "list_type": None,
                    "text": "", "page": page_number,
                    "_image_bytes": image_bytes, "_image_ext": "png",
                })
    finally:
        doc.close()

    return images_by_page


def _insert_page_images(result_sections, images_by_page):
    """
    Splice extracted PDF images into `result_sections` (mutated in place),
    each positioned right after the LAST block anywhere in the document
    (walking sections in `result_sections`'s own iteration order, which
    mirrors document_model.SECTION_ORDER — recognized sections in order,
    then the "body" catch-all last) that shares its page number. This is
    the same fidelity level PDF text extraction already has (per-block
    page numbers, no finer in-page positioning) — see this module's and
    document_model.py's module docstrings.

    A page whose images have no matching text block anywhere (e.g. a page
    that is entirely a figure, with no text PyMuPDF recognized as content)
    falls back to the end of the "body" section, so the image is
    surfaced rather than silently dropped.

    Never raises: image placement is a display nicety layered on top of
    already-extracted text, not something that should ever take down
    extraction — see this module's docstring.
    """
    if not images_by_page:
        return

    try:
        last_position = {}
        for section_name, blocks in result_sections.items():
            for index, block in enumerate(blocks):
                page = block.get("page")
                if page is not None:
                    last_position[page] = (section_name, index)

        # Group insertions per section, applied in descending index order
        # so an earlier insert never shifts a later insertion's index.
        insertions = {}
        fallback_images = []

        for page, images in images_by_page.items():
            target = last_position.get(page)
            if target is None:
                fallback_images.extend(images)
                continue
            section_name, index = target
            insertions.setdefault(section_name, []).append((index, images))

        for section_name, items in insertions.items():
            blocks = result_sections[section_name]
            for index, images in sorted(items, key=lambda item: item[0], reverse=True):
                blocks[index + 1:index + 1] = images

        if fallback_images:
            result_sections.setdefault(FALLBACK_SECTION, [])
            result_sections[FALLBACK_SECTION].extend(fallback_images)
    except Exception:
        logger.exception("Failed to splice extracted PDF images into structured sections.")


# Position-based buckets for content outside the recognized sections, so
# the Document view keeps the original file's order instead of dumping all
# of it into one "body" section at the end:
#   front_matter - before the first section heading (authors, affiliations)
#   back_matter  - after it: References, Acknowledgments, Appendix...
FRONT_MATTER_SECTION = "front_matter"
BACK_MATTER_SECTION = "back_matter"

REFERENCE_HEADING_NAMES = {"references", "bibliography", "tài liệu tham khảo", "tai lieu tham khao"}
PAGE_NUMBER_LINE_RE = re.compile(r'^(?:page\s*)?\d{1,4}(?:\s*(?:/|of)\s*\d{1,4})?$', re.IGNORECASE)
ROMAN_VALUES = {"I": 1, "II": 2, "III": 3, "IV": 4, "V": 5, "VI": 6, "VII": 7, "VIII": 8, "IX": 9, "X": 10}


def _running_noise_line_indices(lines):
    """
    Indices of lines that are page furniture rather than content: bare page
    numbers ("4", "4 / 19", "Page 4") and running headers/footers - short
    lines whose text (digits ignored) repeats on many pages, like a journal
    name or the paper title printed atop every page.
    """
    if not lines:
        return set()

    total_pages = max(line["page"] for line in lines)
    pages_by_key = {}
    for line in lines:
        key = re.sub(r"\d+", "#", normalize_heading_text(line["text"]).lower())
        pages_by_key.setdefault(key, set()).add(line["page"])

    noise = set()
    for i, line in enumerate(lines):
        text = normalize_heading_text(line["text"])
        if PAGE_NUMBER_LINE_RE.match(text):
            noise.add(i)
            continue
        if line["words"] > 10 or total_pages < 3:
            continue
        key = re.sub(r"\d+", "#", text.lower())
        pages = pages_by_key.get(key, ())
        if len(pages) >= 3 and len(pages) >= 0.4 * total_pages:
            noise.add(i)
    return noise


def _title_line_indices(lines):
    """Indices of the lines extract_title_from_lines() joins into the title,
    so the title isn't shown a second time inside the front matter."""
    if not lines:
        return set()
    body_size = get_body_font_size(lines)
    indices = set()
    for i, line in enumerate(lines[:25]):
        lower = line["text"].lower()
        if lower.startswith("abstract") or "introduction" in lower:
            break
        if line["size"] > body_size + 2 and line["words"] >= 3:
            indices.add(i)
    return indices


def _title_continuation_indices(lines, title_indices):
    """
    Title lines extract_title_from_lines() skips because they are short
    (a title wrapped as "... Social Media" + "Streaming Data"): same large
    font, directly after a title line. Returned in order so their text can
    be appended to the title.
    """
    if not lines or not title_indices:
        return []
    body_size = get_body_font_size(lines)
    extra = []
    i = max(title_indices) + 1
    while i < min(len(lines), 25):
        line = lines[i]
        if line["size"] > body_size + 2 and 0 < line["words"] < 3:
            extra.append(i)
            i += 1
            continue
        break
    return extra


def _front_matter_blocks(blocks):
    """
    Authors, affiliations and e-mails are often set a little larger than the
    body text, which classify_block_type() reads as headings. In the front
    matter only a large (level-1) heading is a real heading - consecutive
    ones are one wrapped title - everything else is plain text.
    """
    result = []
    for block in blocks:
        if block.get("type") == "heading" and not block.get("section_heading"):
            if block.get("level") == 1:
                previous = result[-1] if result else None
                if (
                    previous is not None
                    and previous.get("type") == "heading"
                    and previous.get("level") == 1
                    and previous.get("page") == block.get("page")
                ):
                    previous["text"] = previous["text"] + " " + block["text"]
                    continue
                result.append(dict(block))
                continue
            block = {**block, "type": "paragraph", "level": None}
        result.append(block)
    return result


def _leading_section_number(text):
    """1 for "1 Introduction" / "1. Introduction" / "I. INTRODUCTION";
    None for sub-sections ("2.1 ...") and unnumbered text."""
    text = normalize_heading_text(text)
    if SUBSECTION_HEADING_RE.match(text):
        return None
    match = re.match(r'^([1-9]\d?)\.?\s', text)
    if match:
        return int(match.group(1))
    match = re.match(r'^([IVX]{1,4})\.\s', text)
    if match:
        return ROMAN_VALUES.get(match.group(1))
    return None


def _normalize_heading_blocks(blocks):
    """
    Give numbered headings the level their numbering implies ("3 Method" ->
    2, "3.1 Data" -> 3) and re-join a numbered heading that the PDF wrapped
    onto a second line ("2 Fundamental of hate speech detection" +
    "on streaming data").
    """
    result = []
    for block in blocks:
        if block.get("type") == "heading" and not block.get("section_heading"):
            text = block.get("text", "")
            previous = result[-1] if result else None
            if (
                previous is not None
                and previous.get("type") == "heading"
                and not previous.get("section_heading")
                and re.fullmatch(r"[A-Z]\.?", previous.get("text", "").strip())
                and previous.get("page") == block.get("page")
            ):
                # Appendix "A" on its own line, its title on the next one.
                previous["text"] = previous["text"].strip() + " " + text
                previous["level"] = 2
                # Lets a title wrapped onto one more line join it too.
                previous["_numbered"] = True
                continue
            if (
                previous is not None
                and previous.get("type") == "heading"
                and not previous.get("section_heading")
                and previous.get("_numbered")
                and previous.get("page") == block.get("page")
                and not HEADING_NUMBER_PREFIX_RE.match(text)
                and len((previous["text"] + " " + text).split()) <= 24
            ):
                previous["text"] = previous["text"] + " " + text
                continue
            block = dict(block)
            if SUBSECTION_HEADING_RE.match(text):
                block["level"] = 3
                block["_numbered"] = True
            elif _leading_section_number(text) is not None:
                block["level"] = 2
                block["_numbered"] = True
        result.append(block)
    for block in result:
        block.pop("_numbered", None)
    return result


def _enforce_heading_sequence(result_sections, order):
    """
    Numbered top-level headings in a paper only ever count up. A "heading"
    whose number does not (an affiliation footnote "1 Faculty of ..." after
    "1 Introduction", step "2" of an algorithm box inside section 3) is a
    mis-detection: a section-heading block is dropped (it has no text in the
    matching document anyway), any other is shown as a plain paragraph.
    """
    last = 0
    for name in order:
        blocks = result_sections.get(name)
        if not blocks:
            continue
        kept = []
        for block in blocks:
            if block.get("type") == "heading" and block.get("level") == 2:
                number = _leading_section_number(block.get("text", ""))
                if number is not None:
                    if number <= last:
                        if block.get("section_heading"):
                            continue
                        block = {**block, "type": "paragraph", "level": None}
                    else:
                        last = number
            kept.append(block)
        result_sections[name] = kept


def extract_structured_sections_from_pdf(pdf_path, heading_labels=None):
    
    lines = extract_lines_from_pdf(pdf_path)
    body_size = get_body_font_size(lines)
    candidates = build_heading_candidates(lines)
    headings = classify_heading_candidates(candidates, heading_labels)
    noise_indices = _running_noise_line_indices(lines)
    title_indices = _title_line_indices(lines)
    title_continuation = _title_continuation_indices(lines, title_indices)
    title_indices |= set(title_continuation)

    section_names = [
        "abstract", "introduction", "related_work",
        "method", "experiment", "conclusion",
    ]
    blocks_by_section = {name: [] for name in section_names}
    claimed = set()

    for idx, heading in enumerate(headings):
        section = heading["section"]

        if section == "references":
            break

        if section not in blocks_by_section:
            continue

        claimed.add(heading["index"])


        second_index = heading.get("second_index")
        if second_index is not None:
            claimed.add(second_index)
            start = second_index + 1
        else:
            start = heading["index"] + 1

        end = headings[idx + 1]["index"] if idx + 1 < len(headings) else len(lines)

        # Keep the section's own heading line (e.g. "1 INTRODUCTION") as a
        # block so the Document view is split into the same sections as the
        # original file. Flagged `section_heading` so it stays OUT of the
        # matching text (see flatten_structured_sections) and is placed by
        # document_model.build_document as a zero-length block instead.
        heading_text = clean_text(heading.get("text", ""))
        if heading_text and re.search(r"[^\W\d_]{2}", strip_major_marker(heading_text)):
            blocks_by_section[section].append({
                "type": "heading", "level": 2, "list_type": None,
                "text": heading_text,
                "page": lines[heading["index"]]["page"] if lines else 1,
                "section_heading": True,
            })

        inline_content = heading.get("inline_content", "")
        if inline_content:
            blocks_by_section[section].append({
                "type": "paragraph", "level": None, "list_type": None,
                "text": clean_text(inline_content),
                "page": lines[heading["index"]]["page"] if lines else 1,
            })
            # The text after the heading on the same line is the end of
            # that line, so its bold/italic is matched as a suffix.
            if lines:
                inline_marks = _block_marks(
                    [lines[heading["index"]]], blocks_by_section[section][-1]["text"]
                )
                if inline_marks:
                    blocks_by_section[section][-1]["marks"] = inline_marks

        survivors = []
        for i in range(start, min(end, len(lines))):
            line = lines[i]
            normalized = normalize_heading_text(line["text"]).strip().lower()

            if normalized in ["references", "bibliography"]:
                break

            # === ĐÃ THÊM LỌC TOÁN HỌC Ở ĐÂY ===
            if is_heavy_math_line(line["text"]):
                continue
            # ==================================

            # Running headers/footers and page numbers are not content.
            if i in noise_indices:
                continue

            claimed.add(i)
            survivors.append(line)

        blocks_by_section[section].extend(build_structured_blocks(survivors, body_size))

    heading_indices = {h["index"] for h in headings}

    heading_indices |= {h["second_index"] for h in headings if h.get("second_index") is not None}

    unclaimed = [
        lines[i] for i in range(len(lines))
        if i not in claimed and i not in heading_indices
        and not is_heavy_math_line(lines[i]["text"])
    ]
    body_blocks = build_structured_blocks(unclaimed, body_size)

    result_sections = {name: blocks for name, blocks in blocks_by_section.items() if blocks}
    if body_blocks:
        result_sections[FALLBACK_SECTION] = body_blocks

    # Rebuild the section layout in the ORIGINAL file's order, so the
    # Document view has exactly the parts the PDF has: front matter, the
    # recognized sections in the order they appear, then back matter with
    # its own "References" heading. The text of every part is the same
    # content as before (only page furniture and the duplicated title lines
    # are left out), so matching is unaffected apart from that noise.
    first_seen = {}
    for heading in headings:
        first_seen.setdefault(heading["section"], heading["index"])
    first_heading_index = min(first_seen.values()) if first_seen else None
    refs_heading = next((h for h in headings if h["section"] == "references"), None)

    leftover = [
        i for i in range(len(lines))
        if i not in claimed and i not in heading_indices
        and i not in noise_indices and i not in title_indices
        and not is_heavy_math_line(lines[i]["text"])
    ]

    ordered_sections = {}
    if first_heading_index is None:
        body_only = build_structured_blocks([lines[i] for i in leftover], body_size)
        if body_only:
            ordered_sections[FALLBACK_SECTION] = body_only
    else:
        front_blocks = build_structured_blocks(
            [lines[i] for i in leftover if i < first_heading_index], body_size
        )
        if front_blocks:
            ordered_sections[FRONT_MATTER_SECTION] = front_blocks

        for name in sorted(
            (n for n, b in blocks_by_section.items() if b),
            key=lambda n: first_seen.get(n, len(lines)),
        ):
            ordered_sections[name] = blocks_by_section[name]

        refs_index = refs_heading["index"] if refs_heading else None
        back_lines = [i for i in leftover if i > first_heading_index]
        back_blocks = build_structured_blocks(
            [lines[i] for i in back_lines if refs_index is None or i < refs_index], body_size
        )
        if refs_heading is not None:
            refs_text = clean_text(refs_heading.get("text", "")) or "References"
            back_blocks.append({
                "type": "heading", "level": 2, "list_type": None,
                "text": refs_text,
                "page": lines[refs_index]["page"],
                "section_heading": True,
            })
            back_blocks.extend(build_structured_blocks(
                [lines[i] for i in back_lines if i > refs_index], body_size
            ))
        # A "References" line that ended a section without being detected
        # as a heading still reads as the heading of what follows it.
        for block in back_blocks:
            if (
                block.get("type") != "image"
                and normalize_heading_text(block.get("text", "")).lower().rstrip(":") in REFERENCE_HEADING_NAMES
            ):
                block.update({"type": "heading", "level": 2, "list_type": None, "section_heading": True})
        if back_blocks:
            ordered_sections[BACK_MATTER_SECTION] = back_blocks

    for name in list(ordered_sections):
        ordered_sections[name] = _normalize_heading_blocks(ordered_sections[name])
    if FRONT_MATTER_SECTION in ordered_sections:
        ordered_sections[FRONT_MATTER_SECTION] = _front_matter_blocks(
            ordered_sections[FRONT_MATTER_SECTION]
        )
    # Front matter (affiliations numbered 1, 2...) must not set the baseline.
    _enforce_heading_sequence(
        ordered_sections, [n for n in ordered_sections if n != FRONT_MATTER_SECTION]
    )
    result_sections = {name: blocks for name, blocks in ordered_sections.items() if blocks}

    try:
        images_by_page = extract_pdf_images(pdf_path)
        _insert_page_images(result_sections, images_by_page)
    except Exception:
        logger.exception("PDF image extraction failed for %s; continuing without images.", pdf_path)

    title = extract_title_from_lines(lines)
    if title and title_continuation:
        title = clean_text(" ".join([title] + [lines[i]["text"] for i in title_continuation]))

    return {
        "title": title,
        "sections": result_sections,
        # Reading order of the parts, for document_model.build_document.
        "section_order": ["title"] + list(result_sections),
    }


def flatten_structured_sections(structured):
    """
    Collapse extract_structured_sections_from_pdf()'s block lists back to
    the historical {section_name: str} shape that build_chunks_from_sections
    (matching pipeline) and build_weighted_sections (query building) expect.

    Blocks are joined with blank lines ("\\n\\n"), not single spaces — this
    is what previously collapsed every section to one giant paragraph, and
    what lets document_model.build_document() recover per-block spans (and,
    when given `structured_sections`, per-block type/level/list_type) via
    its existing blank-line paragraph splitter.
    """
    sections = {
        "title": structured["title"],
        "abstract": "",
        "introduction": "",
        "related_work": "",
        "method": "",
        "experiment": "",
        "conclusion": "",
    }

    for name, blocks in structured["sections"].items():
        sections[name] = "\n\n".join(
            b["text"] for b in blocks
            if b["text"] and not b.get("section_heading")
        )

    return sections


def extract_sections_from_pdf(pdf_path, heading_labels=None):
    structured = extract_structured_sections_from_pdf(pdf_path, heading_labels)
    sections = flatten_structured_sections(structured)

    print("\n===== DETECTED HEADINGS =====")
    for name, blocks in structured["sections"].items():
        for b in blocks:
            if b["type"] == "heading":
                print(f"{b['text']} => {name}")

    return sections


def debug_font_lines(pdf_path, top_k=80):
    lines = extract_lines_from_pdf(pdf_path)
    lines = sorted(lines, key=lambda x: x["size"], reverse=True)

    print("\n===== FONT DEBUG TOP LINES =====")
    for line in lines[:top_k]:
        print(
            f"p{line['page']} | size={line['size']:.1f} | "
            f"words={line['words']} | {line['text']}"
        )


def debug_heading_candidates(pdf_path):
    lines = extract_lines_from_pdf(pdf_path)
    candidates = build_heading_candidates(lines)

    print("\n===== HEADING CANDIDATES =====")
    for c in candidates:
        print(f"- {c['text']} => {c['section']} ({c['level']})")


def build_weighted_sections(title, abstract, introduction, related_work, method, experiment):
    return {
        "title_abstract": {
            "text": title + "\n" + abstract,
            "weight": 1.0
        },
        "introduction": {
            "text": introduction,
            "weight": 0.8
        },
        "method": {
            "text": method,
            "weight": 0.8
        },
        "experiment": {
            "text": experiment,
            "weight": 0.6
        },
        "related_work": {
            "text": related_work,
            "weight": 0.7
        }
    }
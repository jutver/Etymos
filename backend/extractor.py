import logging
import re
from bisect import bisect_left, bisect_right
from collections import Counter, defaultdict

import pdf_layout
from document_model import SENTENCE_BOUNDARY

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


# Zero-width characters some editors (Google Docs) put after a heading
# number ("I.\u200b INTRODUCTION"): invisible, but they hide the numbering.
ZERO_WIDTH_RE = re.compile("[\u200b\u200c\u200d\u2060\ufeff]")


def line_from_layout(raw):
    """One pdf_layout line as the line dict the rest of this module reads.
    Span text is stripped and joined with " " - the "text" and "spans"
    contract build_structured_blocks()/compute_text_marks() rely on."""
    texts, sizes, fonts = [], [], []
    bold_flags = []
    styled_spans = []

    for span in raw.get("spans", []):
        text = ZERO_WIDTH_RE.sub("", span.get("text", "")).strip()
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
    if not line_text or not sizes:
        return None
    line = {
        "text": line_text,
        "page": raw["page"],
        "size": max(sizes),
        "font": " ".join(fonts),
        "words": len(line_text.split()),
        # True when every text span on the line is bold - used by
        # classify_block_type() to recognise numbered headings set in body
        # size but bold.
        "bold": bool(bold_flags) and all(bold_flags),
        # (text, bold, italic) per span, joined by " " exactly like "text"
        # above - lets build_structured_blocks() keep inline bold/italic as
        # block "marks".
        "spans": styled_spans,
        # Position on the page (pdf_layout.py): paragraph breaks, page
        # furniture, and where tables and figures go back into the flow.
        "bbox": raw.get("bbox"),
        "block": raw.get("block"),
        "block_x0": raw.get("block_x0"),
        "block_x1": raw.get("block_x1"),
        "page_height": raw.get("page_height"),
        "exact_position": raw.get("exact_position", False),
    }
    if raw.get("caption"):
        line["caption"] = raw["caption"]
        line["caption_id"] = raw["caption_id"]
    return line


def _lines_from_layout(layout):
    lines = [line for line in map(line_from_layout, layout["lines"]) if line is not None]
    for index, line in enumerate(lines):
        line["idx"] = index
    return lines


def extract_lines_from_pdf(pdf_path):
    """Content lines of a PDF in reading order, without page furniture or
    the table of contents (see pdf_layout.analyze_pdf). Table and figure
    text is kept: this is the text-only view."""
    return _lines_from_layout(pdf_layout.analyze_pdf(pdf_path, media=False))


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

    exact = mapping.get(compact)
    if exact:
        return exact

    # Fallback for headings the exact table misses: longer English titles
    # ("Results under Exact Forecasts", "Materials and Methods") and
    # Vietnamese ones ("Giới thiệu", "Kết luận").
    return keyword_section_from_heading(raw)


# Keyword fallback for section_from_heading(). Matched against the heading
# lowercased with Vietnamese diacritics removed; checked in order, so the
# more specific buckets come first.
SECTION_KEYWORDS = [
    ("references", ["references", "bibliography", "tai lieu tham khao"]),
    ("abstract", ["abstract", "tom tat"]),
    ("conclusion", ["conclusion", "concluding", "ket luan", "tong ket"]),
    ("introduction", ["introduction", "gioi thieu", "mo dau", "dat van de"]),
    ("related_work", [
        "related work", "background", "literature", "prior work",
        "research context", "tong quan", "co so ly thuyet",
        "nghien cuu lien quan", "cong trinh lien quan",
    ]),
    ("method", [
        "method", "approach", "framework", "architecture", "system model",
        "proposed", "phuong phap", "mo hinh", "de xuat",
    ]),
    ("experiment", [
        "experiment", "result", "evaluation", "discussion",
        "thuc nghiem", "ket qua", "danh gia", "thao luan",
    ]),
]

# "Chương 1.", "Phần II", "Chapter 3:" before the heading's own words.
_CHAPTER_PREFIX_RE = re.compile(
    r"^(chuong|phan|chapter|part|section)\s+([0-9]+|[ivxlc]+)\s*[.:\-]?\s*"
)


def _fold_heading_keep_prefix(text):
    """Lowercase, Vietnamese diacritics removed ("Chương" -> "chuong")."""
    import unicodedata

    text = normalize_heading_text(text).lower().replace("đ", "d")
    text = unicodedata.normalize("NFD", text)
    return "".join(ch for ch in text if unicodedata.category(ch) != "Mn")


def _fold_heading(text):
    text = _fold_heading_keep_prefix(text)
    text = strip_major_marker(text)
    text = _CHAPTER_PREFIX_RE.sub("", text)
    text = re.sub(r"[^\w\s]", " ", text)
    return " ".join(text.split())


def keyword_section_from_heading(text, prefix_only=False):
    folded = _fold_heading(text)

    if not folded:
        return None

    for section, keywords in SECTION_KEYWORDS:
        for kw in keywords:
            if prefix_only:
                # Word prefix: "method" covers "methods", "methodology".
                if folded.startswith(kw):
                    return section
            elif re.search(r"\b" + re.escape(kw), folded):
                return section

    return None


def is_keyword_plain_heading(line, text, body_size):
    """
    Unnumbered heading that is not in is_valid_plain_heading()'s exact list
    ("MỞ ĐẦU", "Chương 1. Tổng quan", "Kết luận và hướng phát triển").
    Needs heading styling (bold or larger than body) and must START with a
    section keyword, so body lines like "kết quả cho thấy ..." are skipped.
    """
    if len(text.split()) > 8 or text.rstrip().endswith((".", ",", ";")):
        return None

    if not (_looks_bold(line) or line.get("size", 0) > body_size + 0.5):
        return None

    return keyword_section_from_heading(text, prefix_only=True)


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

    # A numbered section heading on page 1 ("1. Introduction" set at 14pt
    # over 11pt body) is bigger than body text but is not the title.
    if is_valid_major_heading(text) and section_from_heading(text):
        return False

    # Same for any numbered heading ("1. Bối cảnh chung") or one opening
    # with a section word ("Introduction", "TÓM TẮT") that is clearly
    # smaller than a title (titles run ~1.6x body size and up).
    if line["size"] < body_size * 1.6 and (
        is_valid_major_heading(text)
        or (len(text.split()) <= 8 and keyword_section_from_heading(text, prefix_only=True))
        or _CHAPTER_PREFIX_RE.match(_fold_heading_keep_prefix(text))
        # A bare "1." whose heading words sit on the next line.
        or (len(text.split()) == 1 and is_major_marker(text))
    ):
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

def sentence_windows(text, chunk_size=900, overlap=150):
    """
    (start, end) windows of about `chunk_size` characters over `text`.

    Windows start and end where a sentence starts (the same boundaries
    split_sentences_with_spans uses), so no chunk begins or ends
    mid-sentence. Fixed character windows used to
    cut words in half; the matcher then treated the cut-off pieces
    ("ic vectors (CNN-static)...", "...perform well o") as sentences of
    their own, which showed up as duplicate, overlapping matches.

    Consecutive windows share whole sentences, about `overlap`
    characters' worth. A single sentence longer than twice `chunk_size`
    is cut at a space.
    """
    n = len(text)
    starts = sorted({0} | {m.end() for m in SENTENCE_BOUNDARY.finditer(text) if m.end() < n})

    windows = []
    start = 0

    while start < n:
        limit = start + chunk_size

        if limit >= n:
            end = n
        else:
            end = starts[bisect_right(starts, limit) - 1]

            if end <= start:
                # The sentence at `start` alone is longer than chunk_size.
                i = bisect_right(starts, start)
                end = starts[i] if i < len(starts) else n

                if end - start > 2 * chunk_size:
                    space = text.rfind(" ", start + 1, limit)
                    end = space if space > start else limit

        windows.append((start, end))

        if end >= n:
            break

        # The next window starts on the last sentence that begins at least
        # `overlap` characters before this window's end, but never in its
        # first half, so windows always move forward.
        middle = start + (end - start) // 2
        i = bisect_right(starts, end - overlap) - 1

        if i >= 0 and starts[i] > middle:
            start = starts[i]
        else:
            i = bisect_left(starts, end) - 1
            start = starts[i] if i >= 0 and starts[i] > middle else end

    return windows


def build_chunks_from_sections(
    sections,
    paper_id="input_paper",
    chunk_size=900,
    overlap=150,
    section_offsets=None
):
    """
    Split each section into overlapping chunks that start and end on
    sentence boundaries (see sentence_windows).

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

        text = section_text.strip()
        base = section_offsets.get(section_name)

        for start, end in sentence_windows(text, chunk_size, overlap):
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

        # "4. Save the result to disk." - a numbered list item in body text
        # (body size, not bold, a full sentence), not section 4.
        list_like = (
            not line.get("bold")
            and line.get("size", body_size) < body_size + 0.5
            and text.rstrip().endswith((".", ";", ","))
            and is_major_marker(text.split()[0])
        )

        candidate = None

        if text.lower().startswith("abstract"):
            candidate = {
                "index": i,
                "text": "Abstract",
                "section": "abstract",
                "inline_content": extract_inline_abstract(text),
                "level": "major"
            }

        elif list_like:
            pass

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

        elif is_keyword_plain_heading(line, text, body_size):
            candidate = {
                "index": i,
                "text": text,
                "section": is_keyword_plain_heading(line, text, body_size),
                "inline_content": "",
                "level": "plain"
            }

        if candidate:
            key = f"{candidate['index']}::{candidate['text'].lower()}"

            if key not in seen:
                seen.add(key)
                raw_candidates.append(candidate)

    return filter_and_fix_headings(
        infer_unknown_sections(raw_candidates, lines, body_size)
    )


# Usual order of the parts of a paper / report, used to place a heading
# whose own words name no known section ("3. Building the Prototype").
SECTION_RANK = {
    "abstract": 0, "introduction": 1, "related_work": 2, "method": 3,
    "experiment": 4, "result": 4, "conclusion": 5, "references": 6,
}
CONTENT_SECTIONS = {
    "introduction", "related_work", "method", "experiment", "result", "conclusion",
}


def _is_styled_heading_line(line, body_size):
    return _looks_bold(line) or line.get("size", 0) > body_size + 0.5


def _has_heading_words(text):
    return re.search(r"[^\W\d_]{3}", strip_major_marker(normalize_heading_text(text))) is not None


def _positional_section(prev_section, next_section, is_last, has_conclusion, total):
    """
    Section for an unrecognized top-level heading, from the recognized (or
    already placed) heading before it and the next recognized one after it.
    """
    if prev_section in (None, "abstract"):
        return "introduction"

    if is_last and not has_conclusion and total >= 3 and next_section in (None, "references"):
        return "conclusion"

    nxt = SECTION_RANK.get(next_section, 99)

    if prev_section == "introduction":
        if nxt <= 2:
            return "introduction"
        return "related_work" if nxt == 3 else "method"

    if prev_section == "related_work":
        return "related_work" if nxt <= 2 else "method"

    if prev_section == "method":
        return "method" if nxt <= 4 else "experiment"

    if prev_section in ("experiment", "result"):
        return "experiment"

    return prev_section


def _assign_positions(sequence, after_sequence_section, has_conclusion, before_section=None):
    known_next = [None] * len(sequence)
    upcoming = after_sequence_section
    for k in range(len(sequence) - 1, -1, -1):
        known_next[k] = upcoming
        section = sequence[k]["section"]
        if section not in (None, "unknown"):
            upcoming = section

    prev_section = before_section
    for k, c in enumerate(sequence):
        if c["section"] in (None, "unknown"):
            c["section"] = _positional_section(
                prev_section,
                known_next[k],
                k == len(sequence) - 1,
                has_conclusion,
                len(sequence),
            )
            c["inferred"] = True
        prev_section = c["section"]


def _style_heading_candidates(lines, body_size, taken, keyword_candidates):
    """
    Unnumbered headings recognized by their look alone: the one font style
    (size, bold) used for a handful of short lines, as top-level headings
    are. When some headings were recognized by keyword, their style wins.
    """
    texts = Counter(normalize_heading_text(l["text"]).lower() for l in lines)
    title_lines = _title_line_indices(lines)
    title_lines |= set(_title_continuation_indices(lines, title_lines))
    pool = []

    for i, line in enumerate(lines):
        if i in taken:
            continue

        text = normalize_heading_text(line["text"]).strip()
        words = text.split()

        if not words or len(words) > 12 or texts[text.lower()] > 1:
            continue
        if text.endswith((".", ",", ";", ":")) or not text[0].isupper() and not text[0].isdigit():
            continue
        if not _has_heading_words(text) or is_table_or_equation_like(text):
            continue
        if SUBSECTION_HEADING_RE.match(text) or is_heavy_math_line(text):
            continue
        if not _is_styled_heading_line(line, body_size):
            continue
        # Title / author lines. Not is_probable_title_or_author(): its
        # "short line on page 1" rule would drop every page-1 heading.
        if i in title_lines or "@" in text:
            continue
        if line["page"] == 1 and line.get("size", 0) >= body_size * 1.6:
            continue

        pool.append((i, line, text))

    if not pool:
        return []

    def style(line):
        return (round(line.get("size", 0)), bool(_looks_bold(line)))

    tiers = Counter(style(line) for _, line, _ in pool)
    keyword_styles = Counter(style(lines[c["index"]]) for c in keyword_candidates)

    if keyword_styles:
        chosen = keyword_styles.most_common(1)[0][0]
    else:
        ranked = sorted(tiers, key=lambda s: (-s[0], not s[1]))
        chosen = next((s for s in ranked if 2 <= tiers[s] <= 30), None)

    if chosen is None:
        return []

    return [
        {
            "index": i,
            "text": text,
            "section": "unknown",
            "inline_content": "",
            "level": "major",
        }
        for i, line, text in pool
        if style(line) == chosen
    ]


def infer_unknown_sections(candidates, lines, body_size):
    """
    Give a section to headings whose wording names none, so any document
    (not only papers titled "Introduction / Method / ...") is split into
    parts:

    1. Numbered documents: top-level headings that count up 1, 2, 3 ... and
       are styled as headings form the outline; an unrecognized one is
       placed by its position between recognized ones (first -> introduction,
       last -> conclusion, between -> related work / method / experiment).
    2. Unnumbered documents: keyword headings ("Introduction") plus lines
       in the same heading style form the outline, placed the same way.

    Recognized headings keep their section; lines that are not part of the
    outline stay "unknown" and are dropped by filter_and_fix_headings().
    """
    candidates = sorted(candidates, key=lambda c: c["index"])

    for c in candidates:
        # "TÓM TẮT" (keyword plain heading) is the abstract just like the
        # "Abstract" line build_heading_candidates() marks major itself.
        if c["section"] == "abstract":
            c["level"] = "major"

    abstract = next((c for c in candidates if c["section"] == "abstract"), None)
    references = next((c for c in candidates if c["section"] == "references"), None)
    known_numbers = {
        _leading_section_number(c["text"])
        for c in candidates
        if c["section"] not in (None, "unknown")
    }

    # 1. Numbered outline.
    sequence = []
    last = 0
    for c in candidates:
        if c["level"] != "major" or c["section"] in ("abstract", "references"):
            continue
        if references is not None and c["index"] > references["index"]:
            break

        number = _leading_section_number(c["text"])
        if number is None:
            continue

        if c["section"] not in (None, "unknown"):
            sequence.append(c)
            last = max(last, number)
            continue

        if (
            number == last + 1
            and number not in known_numbers
            and (abstract is None or c["index"] > abstract["index"])
            and _is_styled_heading_line(lines[c["index"]], body_size)
            and _has_heading_words(c["text"])
        ):
            sequence.append(c)
            last = number

    has_conclusion = any(c["section"] == "conclusion" for c in candidates)

    if len(sequence) >= 2:
        _assign_positions(
            sequence,
            "references" if references is not None else None,
            has_conclusion,
            "abstract" if abstract is not None else None,
        )
        return candidates

    # 2. Unnumbered outline.
    keyword_plain = [
        c for c in candidates
        if c["level"] == "plain" and c["section"] in CONTENT_SECTIONS
    ]
    taken = {c["index"] for c in candidates}
    taken |= {c["second_index"] for c in candidates if c.get("second_index") is not None}
    styled = _style_heading_candidates(lines, body_size, taken, keyword_plain)

    if references is not None:
        styled = [c for c in styled if c["index"] < references["index"]]
    if abstract is not None:
        styled = [c for c in styled if c["index"] > abstract["index"]]

    outline = sorted(keyword_plain + styled, key=lambda c: c["index"])

    if len(outline) < 2:
        return candidates

    for c in keyword_plain:
        # Kept even next to the (major) Abstract heading.
        c["level"] = "major"

    _assign_positions(
        outline,
        "references" if references is not None else None,
        has_conclusion,
        "abstract" if abstract is not None else None,
    )

    return candidates + styled


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


def _looks_italic(line):
    spans = line.get("spans") or []
    return bool(spans) and all(italic for _text, _bold, italic in spans)

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
        and _is_clean_heading_rest(text)
        and SUBSECTION_HEADING_RE.match(text)
        and (_looks_bold(line) or (_looks_italic(line) and word_count <= 8))
    ):
        # "2.1 Data" in bold, or "2.1.1. Encoders" in italics (Interspeech).
        return "heading", 3, None, text

    if (
        word_count <= 12
        and not text.endswith((".", ",", ";"))
        and _looks_bold(line)
        and _is_clean_heading_rest(text)
    ):
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


def _continues_list_item(item_lines, line):
    """Whether a body line is the wrapped continuation of a list item: right
    under it, indented past the item's bullet or number."""
    first, last = item_lines[0], item_lines[-1]
    if not first.get("bbox") or not line.get("bbox") or line["page"] != last["page"]:
        return False
    size = line.get("size") or 10
    indent = line["bbox"][0] - first["bbox"][0]
    gap = line["bbox"][1] - last["bbox"][3]
    return 0.4 * size < indent < 3 * size and -size < gap < 0.9 * size


def _stamp_positions(block, source_lines):
    indices = [line["idx"] for line in source_lines if line.get("idx") is not None]
    if indices:
        block["_first_idx"] = min(indices)
        block["_last_idx"] = max(indices)
    # Where each line of the block sits on its page, so a match inside the
    # block can be highlighted in the original PDF (pdf_geometry.py). An
    # in-process carrier like `_image_bytes`: never persisted.
    if source_lines and all(line.get("exact_position") and line.get("bbox") for line in source_lines):
        block["_geometry"] = [
            {"page": line["page"], "bbox": list(line["bbox"]), "text": clean_text(line["text"])}
            for line in source_lines
        ]


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
    into merged structural blocks: the wrapped lines of one paragraph are
    merged into one paragraph block (a new paragraph starts where the
    layout shows one - see pdf_layout.starts_new_paragraph), while every
    heading or list line becomes its own block.

    Returns a list of {"type", "level", "list_type", "text", "page"} dicts.
    Blocks built from positioned lines also carry `_first_idx`/`_last_idx`
    (their lines' reading-order indices, for placing tables and figures)
    and headings `_size` (for heading levels); both are dropped before the
    structure leaves extract_structured_sections_from_pdf.
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
                _stamp_positions(current, source_lines)
                blocks.append(current)
        current = None

    for line in section_lines:
        btype, level, list_type, raw_text = classify_block_type(line, body_size)
        text = clean_text(raw_text)
        if not text:
            continue

        if btype == "paragraph":
            if (
                current is not None and current["type"] == "paragraph"
                and not pdf_layout.starts_new_paragraph(current["_lines"][-1], line, body_size)
            ) or (
                current is not None and current["type"] == "list_item"
                and _continues_list_item(current["_lines"], line)
            ):
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
                # Kept open: the item's wrapped lines follow as "paragraph"
                # lines and join it in the branch above.
                block["_lines"] = [line]
                current = block
                continue
            _stamp_positions(block, [line])
            block["_size"] = line.get("size")
            # Headings keep their marks too: a line read as a heading can
            # later be shown as a plain paragraph (_front_matter_blocks,
            # _enforce_heading_sequence), and its bold words must then still
            # be bold.
            marks = _block_marks([line], text)
            if marks:
                block["marks"] = marks
            blocks.append(block)

    flush()
    return blocks


def _anchor_index(lines, anchor):
    """
    Reading-order index of the last line before a table or figure at
    `anchor` = (page, x0, x1, y0), or -1 when it comes before every line.

    A line wider than the item's column above it (a full-width title, a
    paragraph across both columns) starts the item's band. Within the band
    the item follows the lines above it in its own column and, when it sits
    in the right column, the whole left column. With neither, it follows
    the band's top line, else the previous pages.
    """
    page, x0, x1, y0 = anchor
    same_page = [l for l in lines if l["page"] == page and l.get("bbox")]
    earlier = max((l["idx"] for l in lines if l["page"] < page), default=-1)
    if not same_page:
        return earlier

    above = [
        l for l in same_page
        if l["bbox"][3] <= y0 + 2 and min(l["bbox"][2], x1) - max(l["bbox"][0], x0) > 0
    ]
    in_column = [l for l in above if l["bbox"][0] >= x0 - 20 and l["bbox"][2] <= x1 + 20]
    spanning = [l for l in above if l not in in_column]
    band_top = max((l["bbox"][3] for l in spanning), default=float("-inf"))
    in_column = [l for l in in_column if l["bbox"][1] >= band_top - 1]

    left_margin = min(l["bbox"][0] for l in same_page)
    right_margin = max(l["bbox"][2] for l in same_page)
    left_column = []
    if x0 > (left_margin + right_margin) / 2 - 20:
        left_column = [
            l for l in same_page
            if l["bbox"][2] <= x0 + 2 and l["bbox"][1] >= band_top - 1
        ]
    before = in_column + left_column
    if before:
        return max(l["idx"] for l in before)
    if spanning:
        return max(l["idx"] for l in spanning)
    return earlier


def _layout_item_blocks(layout, lines):
    """Table and figure blocks from pdf_layout.analyze_pdf(), each with the
    reading-order index it follows (`_anchor`).

    A table becomes a "table" block: its cells joined as its text (no "\\n",
    see extract_docx._table_block for why) so it is checked like DOCX
    tables are, and its grid in "rows". A table whose grid could not be
    read reliably (a rotated table, merged cells) also carries a picture of
    itself (`_image_bytes`), which the Document view shows instead of the
    grid. A figure becomes an "image" block with its picture."""
    items = []
    for table in layout.get("tables", []):
        rows = [row for row in table["rows"] if any(cell for cell in row)]
        text = " ¶ ".join(" | ".join(cell for cell in row) for row in rows)
        if not rows or not clean_text(text.replace("|", " ").replace("¶", " ")):
            continue
        block = {
            "type": "table", "level": None, "list_type": None,
            "text": text, "page": table["page"], "rows": rows,
            "_anchor": _anchor_index(lines, table["anchor"]),
        }
        if table.get("image_bytes"):
            block["_image_bytes"] = table["image_bytes"]
            block["_image_ext"] = "png"
        items.append(block)
    for figure in layout.get("figures", []):
        items.append({
            "type": "image", "level": None, "list_type": None,
            "text": "", "page": figure["page"],
            "_image_bytes": figure["image_bytes"], "_image_ext": "png",
            "_anchor": _anchor_index(lines, figure["anchor"]),
        })
    return items


def _insert_layout_items(result_sections, items):
    """
    Put tables and figures (mutating `result_sections`) right after the
    block holding the line they follow in the original page, or at the
    very start when they come before every line.

    Never raises: placement is layered on top of already-extracted text,
    and a failure here must not take extraction down.
    """
    if not items:
        return
    try:
        order = list(result_sections)
        targets = defaultdict(list)
        for item in sorted(items, key=lambda i: i["_anchor"]):
            anchor = item.pop("_anchor")
            best = None
            for name in order:
                for index, block in enumerate(result_sections[name]):
                    last = block.get("_last_idx")
                    if last is not None and last <= anchor and (best is None or last >= best[2]):
                        best = (name, index, last)
            if best is None:
                first = order[0] if order else FALLBACK_SECTION
                result_sections.setdefault(first, [])
                targets[(first, -1)].append(item)
            else:
                targets[(best[0], best[1])].append(item)
        for (name, index), placed in sorted(targets.items(), key=lambda t: t[0][1], reverse=True):
            blocks = result_sections[name]
            blocks[index + 1:index + 1] = placed
    except Exception:
        logger.exception("Failed to place extracted tables and figures in the document.")


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

    pdf_layout.analyze_pdf already removes furniture by position; this is a
    second net for what it misses. A positioned line is only considered at
    the top or bottom of its page, so a real heading whose words a running
    header repeats ("3 Dataset and Preprocessing Pipeline") is kept.
    """
    if not lines:
        return set()

    def at_page_edge(line):
        bbox, height = line.get("bbox"), line.get("page_height")
        if not bbox or not height:
            return True
        edge = pdf_layout.FURNITURE_REGION * height
        return bbox[3] <= edge or bbox[1] >= height - edge

    total_pages = max(line["page"] for line in lines)
    pages_by_key = {}
    for line in lines:
        key = re.sub(r"\d+", "#", normalize_heading_text(line["text"]).lower())
        pages_by_key.setdefault(key, set()).add(line["page"])

    noise = set()
    for i, line in enumerate(lines):
        if not at_page_edge(line):
            continue
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


HEADING_WRAP_WORD_RE = re.compile(
    r"\b(?:for|and|of|with|in|on|to|the|a|an|via|from|by|using|towards|toward|its|their|or)$"
)


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
                and (
                    previous.get("_numbered")
                    # "... representations for" + "BERT-based models": a
                    # heading broken after a word that can't end it.
                    or (
                        HEADING_WRAP_WORD_RE.search(previous.get("text", ""))
                        and abs((previous.get("_size") or 0) - (block.get("_size") or 0)) < 0.5
                    )
                )
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
            elif heading_depth(text) is not None:
                # "D Actual examples ..." / "A.1 Setup": numbered too, so a
                # title wrapped onto the next line joins it.
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

    Reports that number parts in Roman numerals ("II. PEST ANALYSIS") and
    the sections inside each part from 1 again count each scheme on its
    own, the Arabic count starting over under every new part.
    """
    last = {"roman": 0, "arabic": 0}
    for name in order:
        blocks = result_sections.get(name)
        if not blocks:
            continue
        kept = []
        for block in blocks:
            if block.get("type") == "heading" and block.get("level") == 2:
                number = _leading_section_number(block.get("text", ""))
                if number is not None:
                    kind = "roman" if ROMAN_HEADING_RE.match(normalize_heading_text(block.get("text", ""))) else "arabic"
                    if number <= last[kind]:
                        if block.get("section_heading"):
                            continue
                        block = {**block, "type": "paragraph", "level": None}
                    else:
                        last[kind] = number
                        if kind == "roman":
                            last["arabic"] = 0
            kept.append(block)
        result_sections[name] = kept


def extract_structured_sections_from_pdf(pdf_path, heading_labels=None, media=True):
    """
    Structured reading of a PDF: {"title", "sections": {name: [block]},
    "section_order"}. With media=False (source papers, where only the text
    is compared) tables and figures are not extracted and their text stays
    in the flow.
    """
    layout = pdf_layout.analyze_pdf(pdf_path, media=media)
    lines = _lines_from_layout(layout)
    body_size = get_body_font_size(lines)
    candidates = build_heading_candidates(lines)
    headings = classify_heading_candidates(candidates, heading_labels)
    noise_indices = _running_noise_line_indices(lines)
    title_part, subtitle_part = _title_parts(lines)
    title_indices = set(title_part) | set(subtitle_part)

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
            heading_block = {
                "type": "heading", "level": 2, "list_type": None,
                "text": heading_text,
                "page": lines[heading["index"]]["page"] if lines else 1,
                "section_heading": True,
            }
            if lines:
                heading_lines = [lines[heading["index"]]]
                if second_index is not None:
                    heading_lines.append(lines[second_index])
                _stamp_positions(heading_block, heading_lines)
                heading_block["_size"] = lines[heading["index"]].get("size")
            blocks_by_section[section].append(heading_block)

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
                _stamp_positions(blocks_by_section[section][-1], [lines[heading["index"]]])

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
            refs_block = {
                "type": "heading", "level": 2, "list_type": None,
                "text": refs_text,
                "page": lines[refs_index]["page"],
                "section_heading": True,
                "_size": lines[refs_index].get("size"),
            }
            _stamp_positions(refs_block, [lines[refs_index]])
            back_blocks.append(refs_block)
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
    _assign_heading_levels(ordered_sections)
    result_sections = {name: blocks for name, blocks in ordered_sections.items() if blocks}

    title = clean_text(" ".join(lines[i]["text"] for i in sorted(title_indices)))

    # The title as its own part: the main title, plus a subtitle when the
    # cover sets one in a smaller size. `title` above stays the plain joined
    # string the query builders use.
    title_blocks = _title_blocks(lines, title_part, subtitle_part) if title else []
    if title_blocks:
        result_sections = {"title": title_blocks, **result_sections}

    _insert_layout_items(result_sections, _layout_item_blocks(layout, lines))

    for blocks in result_sections.values():
        for block in blocks:
            for key in ("_first_idx", "_last_idx", "_size"):
                block.pop(key, None)

    order = list(result_sections)
    return {
        "title": title,
        "sections": result_sections,
        # Reading order of the parts, for document_model.build_document.
        "section_order": order if "title" in result_sections else ["title"] + order,
    }


AUTHOR_LINE_RE = re.compile(r"[^\W\d_]\s?\d(?:\s?,\s?\d)*\s*(?:,|$)")


def _author_like(text):
    """Author and affiliation lines: several names, an e-mail, or names
    with affiliation numbers ("Luan Thanh Nguyen 1 , 2")."""
    return text.count(",") >= 2 or "@" in text or AUTHOR_LINE_RE.search(text) is not None


def _title_parts(lines):
    """
    (title line indices, subtitle line indices) on the first page.

    The title is the largest text before the abstract/introduction, with
    the lines right under it in the same size. A subtitle is the group set
    right below it in a smaller size that is still well above the body
    text - not the author line, which often is too. Without line positions
    the old rule applies (every large line is the title, no subtitle).
    """
    if not lines:
        return [], []
    body_size = get_body_font_size(lines)
    first_page = lines[0]["page"]
    head = []
    for line in lines[:40]:
        if line["page"] != first_page:
            break
        lower = normalize_heading_text(line["text"]).lower()
        if lower.startswith("abstract") or re.match(r"^(?:\d+\.?\s+|[ivx]+\.\s+)?introduction\b", lower):
            break
        head.append(line)
    if not head or any(not line.get("bbox") for line in head):
        indices = _title_line_indices(lines)
        indices |= set(_title_continuation_indices(lines, indices))
        return sorted(indices), []

    big = [
        l for l in head
        if l["size"] > body_size + 2 and re.search(r"[^\W\d_]{2}", l["text"]) and not _author_like(l["text"])
    ]
    if not big:
        return [], []
    top = max(l["size"] for l in big)
    by_y = sorted(head, key=lambda l: (l["bbox"][1], l["bbox"][0]))
    first = min((l for l in big if abs(l["size"] - top) < 0.6), key=lambda l: l["bbox"][1])
    position = by_y.index(first)
    title = [first]
    for line in by_y[position + 1:]:
        if abs(line["size"] - top) < 0.6 and line["bbox"][1] - title[-1]["bbox"][3] < 0.8 * top:
            title.append(line)
        else:
            break
    rest = by_y[position + len(title):]
    subtitle = []
    if rest:
        candidate = rest[0]
        if (
            body_size + 2 <= candidate["size"] < top - 0.6
            and candidate["words"] >= 2 and not _author_like(candidate["text"])
        ):
            subtitle = [candidate]
            for line in rest[1:]:
                if (
                    abs(line["size"] - candidate["size"]) < 0.6
                    and line["bbox"][1] - subtitle[-1]["bbox"][3] < 0.8 * candidate["size"]
                    and not _author_like(line["text"])
                ):
                    subtitle.append(line)
                else:
                    break
    return [l["idx"] for l in title], [l["idx"] for l in subtitle]


def _title_blocks(lines, title_part, subtitle_part):
    """The title as "title" blocks: the main title (level 1) and, when the
    cover has one, its subtitle (level 2), in page order."""
    blocks = []
    for indices, level in ((title_part, 1), (subtitle_part, 2)):
        group = [lines[i] for i in indices]
        text = clean_text(" ".join(l["text"] for l in group))
        if not text:
            continue
        block = {
            "type": "title", "level": level, "list_type": None,
            "text": text, "page": group[0]["page"],
        }
        _stamp_positions(block, group)
        blocks.append(block)
    blocks.sort(key=lambda b: b.get("_first_idx", 0))
    return blocks


HEADING_NUMBER_DEPTH_RE = re.compile(r'^(\d{1,2}(?:\.\d{1,2}){0,4})\.?\s+\S')
APPENDIX_NUMBER_DEPTH_RE = re.compile(r'^[A-Z]((?:\.\d{1,2}){1,3})\.?\s+\S')
APPENDIX_LETTER_RE = re.compile(r'^[A-Z]\.\s+[A-Z]')
ROMAN_HEADING_RE = re.compile(r'^[IVX]{1,4}\.\s+\S')
CHAPTER_HEADING_RE = re.compile(
    r'^(?:chapter|chương|chuong|part|phần|phan)\s+(?:\d+|[ivxlc]+)\b', re.IGNORECASE
)


def heading_depth(text):
    """How deep a heading's own numbering goes: "3 Method" -> 1, "3.1" -> 2,
    "3.1.2" -> 3, "A.1" -> 2, "IV. RESULTS" -> 1, "Chapter 2" -> 0. None
    for an unnumbered heading."""
    text = normalize_heading_text(text)
    if CHAPTER_HEADING_RE.match(text):
        return 0
    match = HEADING_NUMBER_DEPTH_RE.match(text)
    if match:
        return match.group(1).count(".") + 1
    match = APPENDIX_NUMBER_DEPTH_RE.match(text)
    if match:
        return match.group(1).count(".") + 1
    if ROMAN_HEADING_RE.match(text) or APPENDIX_LETTER_RE.match(text):
        return 1
    return None


def _assign_heading_levels(sections):
    """
    Heading levels for the whole document, so the Document view shows a
    real outline. Level 1 is a chapter/part, 2 a top-level section, 3 a
    subsection, 4 anything deeper (the title has its own "title" blocks).

    A numbered heading's level comes from its numbering ("3" -> 2, "3.1" ->
    3, "3.1.2" -> 4). An unnumbered one takes the level of numbered
    headings set in the same size; with no numbered headings to compare
    with, the distinct heading sizes are ranked, largest first.
    Front matter keeps its own rules (_front_matter_blocks).
    """
    headings = [
        block
        for name, blocks in sections.items() if name not in (FRONT_MATTER_SECTION, "title")
        for block in blocks if block.get("type") == "heading"
    ]
    texts = [normalize_heading_text(block.get("text", "")) for block in headings]
    # Roman-numbered parts with Arabic-numbered sections inside them: the
    # Arabic outline sits one level down.
    nested = any(ROMAN_HEADING_RE.match(t) for t in texts) and any(
        HEADING_NUMBER_DEPTH_RE.match(t) for t in texts
    )
    numbered, unnumbered = [], []
    for block, text in zip(headings, texts):
        depth = heading_depth(text)
        if depth is None:
            unnumbered.append(block)
            continue
        if nested and HEADING_NUMBER_DEPTH_RE.match(text):
            depth += 1
        block["level"] = 1 if depth == 0 else min(depth + 1, 4)
        numbered.append(block)

    sized = [b for b in unnumbered if b.get("_size")]
    if not sized:
        return
    by_size = defaultdict(Counter)
    for block in numbered:
        if block.get("_size"):
            by_size[block["_size"]][block["level"]] += 1
    if by_size:
        for block in sized:
            size = block["_size"]
            close = [s for s in by_size if abs(s - size) < 0.75]
            if close:
                nearest = min(close, key=lambda s: abs(s - size))
                block["level"] = by_size[nearest].most_common(1)[0][0]
                continue
            larger = [s for s in by_size if s > size]
            if not larger:
                block["level"] = min(by_size[max(by_size)].most_common(1)[0][0], 2)
            else:
                block["level"] = min(by_size[min(larger)].most_common(1)[0][0] + 1, 4)
        return
    ranks = []
    for size in sorted({b["_size"] for b in sized}, reverse=True):
        if ranks and ranks[-1] - size < 0.75:
            continue
        ranks.append(size)
    for block in sized:
        rank = max(i for i, size in enumerate(ranks) if size >= block["_size"] - 0.75)
        block["level"] = min(2 + rank, 4)


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


def extract_sections_from_pdf(pdf_path, heading_labels=None, media=False):
    # Text only by default: this is how source papers are read, and their
    # tables and figures are never shown.
    structured = extract_structured_sections_from_pdf(pdf_path, heading_labels, media=media)
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
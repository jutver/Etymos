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
    math_symbols = set("=+-×÷±∈∉∑∏∫≈≠≤≥∝∞∇∂⊕⊗")
    symbol_count = sum(1 for c in text if c in math_symbols)

    # Nếu 1 dòng ngắn hoặc vừa mà có từ 3-4 ký hiệu toán học trở lên -> Chắc chắn là phương trình
    if symbol_count >= 3:
        return True

    # 3. Heuristic dựa trên tỷ lệ chữ cái
    # Dòng text bình thường sẽ có mật độ chữ cái (a-z) rất cao.
    # Công thức toán thường chứa nhiều khoảng trắng, ngoặc, số, và ký tự rời rạc.
    alpha_count = sum(1 for c in text if c.isalpha())
    total_chars = len(text.replace(" ", ""))

    if total_chars > 0:
        # Nếu chưa tới 50% số ký tự là chữ cái, và có chứa toán học/số -> Loại bỏ
        if alpha_count / total_chars < 0.5 and (symbol_count > 0 or any(c.isdigit() for c in text)):
            return True

    return False


def extract_lines_from_pdf(pdf_path):
    doc = fitz.open(pdf_path)
    lines = []

    for page_idx, page in enumerate(doc):
        data = page.get_text("dict")

        for block in data.get("blocks", []):
            for line in block.get("lines", []):
                texts, sizes, fonts = [], [], []

                for span in line.get("spans", []):
                    text = span.get("text", "").strip()
                    if text:
                        texts.append(text)
                        sizes.append(span.get("size", 0))
                        fonts.append(span.get("font", ""))

                line_text = " ".join(texts).strip()

                if line_text and sizes:
                    lines.append({
                        "text": line_text,
                        "page": page_idx + 1,
                        "size": max(sizes),
                        "font": " ".join(fonts),
                        "words": len(line_text.split())
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

    if size >= body_size + 5 and word_count <= 20:
        return "heading", 1, None, text
    if size >= body_size + 2.5 and word_count <= 20:
        return "heading", 2, None, text
    if size >= body_size + 1 and word_count <= 16:
        return "heading", 3, None, text

    marker = LIST_MARKER_RE.match(text)
    if marker:
        stripped = text[marker.end():].strip()
        if stripped:
            marker_text = marker.group(0).strip()
            list_type = "bullet" if marker_text[:1] in BULLET_MARKER_CHARS else "number"
            return "list_item", None, list_type, stripped

    return "paragraph", None, None, text


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
            if cleaned:
                current["text"] = cleaned
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
            else:
                flush()
                current = {
                    "type": "paragraph", "level": None, "list_type": None,
                    "text": text, "page": line["page"],
                }
        else:
            flush()
            blocks.append({
                "type": btype, "level": level, "list_type": list_type,
                "text": text, "page": line["page"],
            })

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


def extract_structured_sections_from_pdf(pdf_path, heading_labels=None):
    
    lines = extract_lines_from_pdf(pdf_path)
    body_size = get_body_font_size(lines)
    candidates = build_heading_candidates(lines)
    headings = classify_heading_candidates(candidates, heading_labels)

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

        inline_content = heading.get("inline_content", "")
        if inline_content:
            blocks_by_section[section].append({
                "type": "paragraph", "level": None, "list_type": None,
                "text": clean_text(inline_content),
                "page": lines[heading["index"]]["page"] if lines else 1,
            })

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

    try:
        images_by_page = extract_pdf_images(pdf_path)
        _insert_page_images(result_sections, images_by_page)
    except Exception:
        logger.exception("PDF image extraction failed for %s; continuing without images.", pdf_path)

    return {
        "title": extract_title_from_lines(lines),
        "sections": result_sections,
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
        sections[name] = "\n\n".join(b["text"] for b in blocks if b["text"])

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
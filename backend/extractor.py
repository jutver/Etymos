import fitz
from collections import Counter


ROMAN = {"I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"}


def clean_text(text):
    text = text.replace("￾", "")
    text = text.replace("—", " ")
    text = text.replace("-\n", "")
    text = " ".join(text.split())
    return text.strip()


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

    # If the line is exactly "Abstract", content is on following lines.
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

    if line["page"] == 1 and line["size"] > body_size + 2:
        return True

    if "@" in text:
        return True

    if line["page"] == 1 and line["words"] <= 5 and line["size"] >= body_size:
        first = text.split()[0] if text.split() else ""

        if not is_major_marker(first) and text.lower() != "abstract":
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

    # Loại footnote/link/citation
    if (
        "http://" in rest_lower
        or "https://" in rest_lower
        or "www." in rest_lower
        or rest_lower.startswith("doi")
    ):
        return False

    # Loại dòng bảng/số liệu
    if is_table_or_equation_like(rest):
        return False

    # Major heading thường ngắn
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

def build_chunks_from_sections(sections, paper_id="input_paper", chunk_size=900, overlap=150):
    chunks = []

    for section_name, section_text in sections.items():
        if section_name == "title":
            continue

        if not section_text or len(section_text.strip()) < 50:
            continue

        start = 0
        text = section_text.strip()

        while start < len(text):
            end = start + chunk_size
            chunk_text = text[start:end].strip()

            if len(chunk_text) >= 80:
                chunks.append({
                    "paper_id": paper_id,
                    "section": section_name,
                    "chunk_id": f"{paper_id}_{section_name}_{len(chunks)}",
                    "start_char": start,
                    "end_char": min(end, len(text)),
                    "text": chunk_text
                })

            start += chunk_size - overlap

    return chunks

def build_heading_candidates(lines):
    """
    Main design:
    - Prefer major headings: 1 Introduction, 2 Related Work, 3 Some Model, 4 Experiments.
    - Plain headings such as Dataset/Evaluation are only used if no major experiment heading exists.
    - Unknown major heading is kept for positional fallback.
    """
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

        # Abstract inline or standalone.
        if text.lower().startswith("abstract"):
            candidate = {
                "index": i,
                "text": "Abstract",
                "section": "abstract",
                "inline_content": extract_inline_abstract(text),
                "level": "major"
            }

        # Major heading in one line: "3 VIHATET5", "4 Experiments and Results".
        elif is_valid_major_heading(text):
            section = section_from_heading(text) or "unknown"
            candidate = {
                "index": i,
                "text": text,
                "section": section,
                "inline_content": "",
                "level": "major"
            }

        # Split major heading: "3" + "VIHATET5".
        elif is_major_marker(text) and i + 1 < len(lines):
            next_text = normalize_heading_text(lines[i + 1]["text"]).strip()
            combined = f"{text} {next_text}"

            if is_valid_major_heading(combined):
                section = section_from_heading(combined) or "unknown"
                candidate = {
                    "index": i,
                    "text": combined,
                    "section": section,
                    "inline_content": "",
                    "level": "major"
                }

        # Plain heading fallback.
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
    """
    1. If major headings exist, remove plain duplicate/subsection headings.
    2. Convert unknown major heading between related_work and experiment/conclusion into method.
    3. Remove result section from retrieval boundary by keeping it as experiment.
    """
    candidates = sorted(candidates, key=lambda x: x["index"])

    has_major = any(c["level"] == "major" for c in candidates)
    filtered = []

    for c in candidates:
        if has_major and c["level"] == "plain":
            # Keep only References as plain heading; ignore Dataset/Evaluation/Conclusions duplicates.
            if c["section"] == "references":
                filtered.append(c)
            continue

        filtered.append(c)

    # Positional fallback for unknown major heading.
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

    # Convert result to experiment for current retrieval sections.
    for c in filtered:
        if c["section"] == "result":
            c["section"] = "experiment"

    # Drop remaining unknowns.
    filtered = [c for c in filtered if c["section"] != "unknown"]

    # Deduplicate same section heading repeated closely.
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


def extract_sections_from_pdf(pdf_path, heading_labels=None):
    lines = extract_lines_from_pdf(pdf_path)
    candidates = build_heading_candidates(lines)
    headings = classify_heading_candidates(candidates, heading_labels)

    sections = {
        "title": extract_title_from_lines(lines),
        "abstract": "",
        "introduction": "",
        "related_work": "",
        "method": "",
        "experiment": "",
        "conclusion": "",
    }

    print("\n===== DETECTED HEADINGS =====")
    for h in headings:
        print(f"{h['text']} => {h['section']}")

    for idx, heading in enumerate(headings):
        section = heading["section"]

        if section == "references":
            break

        if section not in sections:
            continue

        start = heading["index"] + 1
        end = headings[idx + 1]["index"] if idx + 1 < len(headings) else len(lines)

        content = []

        inline_content = heading.get("inline_content", "")
        if inline_content:
            content.append(inline_content)

        for line in lines[start:end]:
            text = line["text"]
            normalized = normalize_heading_text(text).strip().lower()

            if normalized in ["references", "bibliography"]:
                break

            content.append(text)

        section_text = clean_text(" ".join(content))

        if section_text:
            sections[section] = (
                sections.get(section, "") + " " + section_text
            ).strip()

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

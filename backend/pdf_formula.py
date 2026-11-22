r"""
pdf_formula.py
--------------
CPU-first mathematical formula detection, validation, LaTeX OCR recognition,
cropped PNG fallback generation, and inline formula detection.

Design goals (`specs/001-pdf-extraction-report-rendering/`):
- Detect display formulas from DocLayout-YOLO `isolate_formula` boxes and native
  math-font / operator / equation-number heuristics without false-positiving on
  hyphenated prose or numeric tables.
- Recognize LaTeX on CPU via `rapid_latex_ocr` when local ONNX weights exist
  (or `OCR_AUTO_DOWNLOAD=true`); never block offline unit tests with hidden
  network downloads.
- Validate produced LaTeX strictly (balanced braces, balanced `\begin`/`\end`,
  no raw HTML/script vectors), falling back to a 250 DPI cropped PNG image
  (`image_bytes`) when recognition is unavailable, fails, or produces invalid LaTeX.
- Keep display equations out of canonical `input_text` plagiarism matching, and
  annotate prose lines with exact `[start, end]` `inline_formulas` ranges.
"""

from __future__ import annotations

import logging
import re
import threading
from pathlib import Path
from typing import Any

import fitz
import numpy as np

import pdf_ocr

logger = logging.getLogger(__name__)

FORMULA_CROP_DPI = 250
MAX_LATEX_LENGTH = 1500

_ENGINE_LOCK = threading.Lock()
_LATEX_OCR_ENGINE: Any = None
_LATEX_OCR_ATTEMPTED = False

_EQUATION_NUM_RE = re.compile(r"^\s*\((\d{1,3}(?:\.\d{1,2})?[a-zA-Z]?)\)\s*$")
_ARXIV_STAMP_RE = re.compile(r"^\s*arXiv\s*:\s*\d{4}\.\d{4,5}", re.IGNORECASE)
_PURE_NUMERIC_ROW_RE = re.compile(r"^\s*(?:\d+(?:[.,]\d+)?%?\s+){2,}\d+(?:[.,]\d+)?%?\s*$")

_MATH_FONT_TOKENS = (
    "cmmi",
    "cmsy",
    "cmex",
    "msam",
    "msbm",
    "eufm",
    "eurm",
    "stmary",
    "wasy",
    "cambriamath",
    "cambria math",
    "stix",
    "latinmodern-math",
    "lmmath",
    "xits",
    "asanamath",
    "mathtime",
    "mtpro",
    "symbol",
    "texgyre",
)

_STRONG_MATH_OPERATORS = set("=∈∉∑∏∫≈≠≤≥∝∞∇∂⊕⊗−√∀∃⊂⊃⊆⊇∪∩→↔⇒⇔⋅±×÷")
_ALL_MATH_OPERATORS = _STRONG_MATH_OPERATORS | set("+*/^")
_GREEK_RANGE_RE = re.compile(r"[\u0391-\u03a9\u03b1-\u03c9]")
_LONG_PROSE_WORD_RE = re.compile(r"\b[^\W\d_]{4,}\b")
_SPACED_MINUS_RE = re.compile(r"(?<=\s)-(?=\s)")
_INLINE_DOLLAR_RE = re.compile(r"\$([^$\n]{1,120})\$")
_MATH_ATOM = r"(?:[A-Za-z0-9_.\u0391-\u03c9ℝℕℤℂ₀-₉ᵢⱼₙₖ²³¹√']{1,16}(?:\([^()\n]{1,20}\))?|\([^()\n]{1,24}\))"
_BINARY_ARITH_OP = r"(?:\s*[+\-*/±×÷·⋅]\s*)"
_INLINE_EXPR_RE = re.compile(
    r"(?<![A-Za-z0-9_/.:-])"
    r"(?:"
    + _MATH_ATOM
    + r"\s*[=≈≠≤≥∈∉⊂⊃⊆⊇→⇒]\s*"
    + _MATH_ATOM
    + r"(?:"
    + _BINARY_ARITH_OP
    + _MATH_ATOM
    + r")*"
    r"|"
    + r"[∑∏∫∇∂][₀-₉ᵢⱼₙₖA-Za-z0-9_\^{}\u0391-\u03c9]{0,8}\s*"
    + _MATH_ATOM
    + r"(?:"
    + _BINARY_ARITH_OP
    + _MATH_ATOM
    + r")*"
    r"|"
    + r"[α-ωΑ-ΩΔΣΠΦΨΩ][₀-₉ᵢⱼₙₖ²³¹_]*(?:"
    + _BINARY_ARITH_OP
    + _MATH_ATOM
    + r")+"
    r")"
)
_UNSAFE_LATEX_RE = re.compile(
    r"<\s*/?\s*(?:script|iframe|object|embed|svg|style|link|meta)\b|javascript\s*:|on\w+\s*=|\\href\s*\{\s*javascript:",
    re.IGNORECASE,
)

_UNICODE_TO_LATEX = {
    "∑": r"\sum ",
    "∏": r"\prod ",
    "∫": r"\int ",
    "∂": r"\partial ",
    "∇": r"\nabla ",
    "∞": r"\infty ",
    "≈": r" \approx ",
    "≠": r" \neq ",
    "≤": r" \leq ",
    "≥": r" \geq ",
    "±": r" \pm ",
    "×": r" \times ",
    "÷": r" \div ",
    "∈": r" \in ",
    "∉": r" \notin ",
    "⊂": r" \subset ",
    "⊃": r" \supset ",
    "⊆": r" \subseteq ",
    "⊇": r" \supseteq ",
    "∪": r" \cup ",
    "∩": r" \cap ",
    "∀": r"\forall ",
    "∃": r"\exists ",
    "∧": r" \wedge ",
    "∨": r" \vee ",
    "⊕": r" \oplus ",
    "⊗": r" \otimes ",
    "→": r" \to ",
    "↔": r" \leftrightarrow ",
    "⇒": r" \Rightarrow ",
    "⇔": r" \Leftrightarrow ",
    "⋅": r" \cdot ",
    "·": r" \cdot ",
    "−": "-",
    "√": r"\sqrt",
    "ℝ": r"\mathbb{R}",
    "ℕ": r"\mathbb{N}",
    "ℤ": r"\mathbb{Z}",
    "ℂ": r"\mathbb{C}",
    "²": "^2",
    "³": "^3",
    "¹": "^1",
    "₀": "_0",
    "₁": "_1",
    "₂": "_2",
    "₃": "_3",
    "₄": "_4",
    "₅": "_5",
    "₆": "_6",
    "₇": "_7",
    "₈": "_8",
    "₉": "_9",
    "ᵢ": "_i",
    "ⱼ": "_j",
    "ₙ": "_n",
    "ₖ": "_k",
    "α": r"\alpha ",
    "β": r"\beta ",
    "γ": r"\gamma ",
    "δ": r"\delta ",
    "ε": r"\epsilon ",
    "ϵ": r"\epsilon ",
    "ζ": r"\zeta ",
    "η": r"\eta ",
    "θ": r"\theta ",
    "λ": r"\lambda ",
    "μ": r"\mu ",
    "ν": r"\nu ",
    "ξ": r"\xi ",
    "π": r"\pi ",
    "ρ": r"\rho ",
    "σ": r"\sigma ",
    "τ": r"\tau ",
    "φ": r"\phi ",
    "ϕ": r"\varphi ",
    "χ": r"\chi ",
    "ψ": r"\psi ",
    "ω": r"\omega ",
    "Δ": r"\Delta ",
    "Θ": r"\Theta ",
    "Λ": r"\Lambda ",
    "Π": r"\Pi ",
    "Σ": r"\Sigma ",
    "Φ": r"\Phi ",
    "Ψ": r"\Psi ",
    "Ω": r"\Omega ",
}


def validate_latex(latex: str | None) -> bool:
    """Validate that `latex` has safe, balanced syntax suitable for KaTeX."""
    if not isinstance(latex, str):
        return False
    stripped = latex.strip()
    if not stripped or len(stripped) > MAX_LATEX_LENGTH:
        return False
    if _UNSAFE_LATEX_RE.search(stripped):
        return False
    for ch in stripped:
        code = ord(ch)
        if ch == "\ufffd" or 0xE000 <= code <= 0xF8FF or (code < 32 and ch not in "\t\n\r"):
            return False

    depth = 0
    i = 0
    n = len(stripped)
    while i < n:
        ch = stripped[i]
        if ch == "\\" and i + 1 < n:
            i += 2
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth < 0:
                return False
        i += 1
    if depth != 0:
        return False

    env_stack: list[str] = []
    for match in re.finditer(r"\\(begin|end)\s*\{([^}]+)\}", stripped):
        kind, env_name = match.group(1), match.group(2).strip()
        if not env_name:
            return False
        if kind == "begin":
            env_stack.append(env_name)
        else:
            if not env_stack or env_stack[-1] != env_name:
                return False
            env_stack.pop()
    return not env_stack


def _resolve_local_latex_ocr_files() -> dict[str, Path] | None:
    cfg = pdf_ocr.get_ocr_config()
    candidates = [cfg["latex_ocr_dir"]]
    try:
        import rapid_latex_ocr

        candidates.append(Path(rapid_latex_ocr.__file__).resolve().parent / "models")
    except Exception:
        pass

    required = {
        "image_resizer_path": "image_resizer.onnx",
        "encoder_path": "encoder.onnx",
        "decoder_path": "decoder.onnx",
        "tokenizer_json": "tokenizer.json",
    }
    for base in candidates:
        resolved = {key: base / fname for key, fname in required.items()}
        if all(path.is_file() for path in resolved.values()):
            return resolved
    return None


def get_latex_ocr_engine():
    """Return cached CPU RapidLaTeXOCR engine when local weights exist or download is allowed."""
    global _LATEX_OCR_ENGINE, _LATEX_OCR_ATTEMPTED
    if _LATEX_OCR_ATTEMPTED:
        return _LATEX_OCR_ENGINE or None
    with _ENGINE_LOCK:
        if _LATEX_OCR_ATTEMPTED:
            return _LATEX_OCR_ENGINE or None
        _LATEX_OCR_ATTEMPTED = True
        local_files = _resolve_local_latex_ocr_files()
        cfg = pdf_ocr.get_ocr_config()
        if local_files is None and not cfg["auto_download"]:
            _LATEX_OCR_ENGINE = False
            return None
        try:
            import rapid_latex_ocr

            ocr_cls = getattr(rapid_latex_ocr, "LaTeXOCR", None) or getattr(rapid_latex_ocr, "LatexOCR", None)
            if ocr_cls is None:
                raise ImportError("rapid_latex_ocr exports neither LaTeXOCR nor LatexOCR")
            if local_files is not None:
                _LATEX_OCR_ENGINE = ocr_cls(**{k: str(v) for k, v in local_files.items()})
            else:
                _LATEX_OCR_ENGINE = ocr_cls()
        except Exception:
            logger.warning("Could not initialize RapidLaTeXOCR engine; using PNG fallback.", exc_info=True)
            _LATEX_OCR_ENGINE = False
        return _LATEX_OCR_ENGINE or None


def reset_formula_engine_cache() -> None:
    """Test helper to reset cached engine initialization."""
    global _LATEX_OCR_ENGINE, _LATEX_OCR_ATTEMPTED
    with _ENGINE_LOCK:
        _LATEX_OCR_ENGINE = None
        _LATEX_OCR_ATTEMPTED = False


def _native_text_to_latex(text: str) -> str | None:
    cleaned = " ".join((text or "").split()).strip()
    if not cleaned:
        return None
    if any(ch == "\ufffd" or 0xE000 <= ord(ch) <= 0xF8FF for ch in cleaned):
        return None
    out: list[str] = []
    for ch in cleaned:
        out.append(_UNICODE_TO_LATEX.get(ch, ch))
    candidate = re.sub(r"\s{2,}", " ", "".join(out)).strip()
    candidate = re.sub(r"\s+([_^])", r"\1", candidate)
    return candidate if validate_latex(candidate) else None


def _is_math_font(font_name: str) -> bool:
    low = (font_name or "").lower()
    return any(tok in low for tok in _MATH_FONT_TOKENS) or low.endswith("-math") or "math" in low


def _math_line_features(line: dict[str, Any], body_size: float) -> dict[str, Any]:
    text = (line.get("text") or "").strip()
    spans = line.get("spans") or []

    total_chars = 0
    math_font_chars = 0
    has_pua = False
    for span in spans:
        stext = span.get("text") or ""
        sfont = span.get("font") or ""
        non_space = sum(1 for c in stext if not c.isspace())
        total_chars += non_space
        if _is_math_font(sfont):
            math_font_chars += non_space
        if any(0xE000 <= ord(c) <= 0xF8FF for c in stext):
            has_pua = True

    math_font_share = (math_font_chars / total_chars) if total_chars > 0 else 0.0
    strong_ops = sum(1 for c in text if c in _STRONG_MATH_OPERATORS)
    strong_ops += len(_SPACED_MINUS_RE.findall(text))
    all_ops = sum(1 for c in text if c in _ALL_MATH_OPERATORS) + strong_ops
    greek_count = len(_GREEK_RANGE_RE.findall(text))
    alpha_count = sum(1 for c in text if c.isalpha())
    non_space_len = len(text.replace(" ", ""))
    alpha_ratio = (alpha_count / non_space_len) if non_space_len > 0 else 0.0
    long_prose_words = sum(1 for m in _LONG_PROSE_WORD_RE.finditer(text) if not _GREEK_RANGE_RE.search(m.group(0)))
    eq_num_match = _EQUATION_NUM_RE.match(text)

    return {
        "text": text,
        "eq_num": f"({eq_num_match.group(1)})" if eq_num_match else None,
        "math_font_share": math_font_share,
        "has_pua": has_pua,
        "strong_ops": strong_ops,
        "all_ops": all_ops,
        "greek_count": greek_count,
        "alpha_count": alpha_count,
        "alpha_ratio": alpha_ratio,
        "long_prose_words": long_prose_words,
        "body_size": body_size,
    }


def _is_display_math_candidate(line: dict[str, Any], feat: dict[str, Any], has_row_eq_num: bool) -> bool:
    text = feat["text"]
    if not text or feat["eq_num"] is not None:
        return False
    if line.get("caption") or _ARXIV_STAMP_RE.match(text):
        return False
    if re.search(r"\bet\s+al\b", text, re.IGNORECASE):
        return False
    if _PURE_NUMERIC_ROW_RE.match(text):
        return False
    if text.rstrip().endswith("-") and feat["strong_ops"] == 0 and feat["math_font_share"] < 0.45:
        return False
    # Hyphenated English/Vietnamese prose words must never trigger display math.
    if re.search(r"[A-Za-z]{2,}-[A-Za-z]{2,}", text) and feat["strong_ops"] == 0 and feat["math_font_share"] < 0.45:
        return False

    if feat["alpha_count"] == 0 and feat["strong_ops"] == 0 and not feat["has_pua"]:
        return False

    # Do not extract prose sentences containing an isolated inline expression as display formulas.
    if feat["long_prose_words"] >= 5 and not has_row_eq_num and feat["math_font_share"] < 0.70:
        return False
    if feat["long_prose_words"] >= 3 and text.rstrip().endswith((".", ",", ";")) and not has_row_eq_num and feat["strong_ops"] < 2:
        return False

    if feat["strong_ops"] >= 3 and feat["long_prose_words"] <= 4:
        return True
    if feat["strong_ops"] >= 1 and (
        has_row_eq_num
        or feat["math_font_share"] >= 0.35
        or feat["greek_count"] >= 1
        or (feat["alpha_ratio"] < 0.65 and feat["long_prose_words"] <= 2)
    ):
        return True
    if feat["math_font_share"] >= 0.60 and feat["long_prose_words"] <= 2 and (feat["all_ops"] >= 1 or has_row_eq_num):
        return True
    if has_row_eq_num and feat["long_prose_words"] <= 3 and (feat["all_ops"] >= 1 or feat["greek_count"] >= 1 or feat["has_pua"]):
        return True
    return False


def _recognize_crop_with_onnx(image_bytes: bytes) -> str | None:
    engine = get_latex_ocr_engine()
    if engine is None or not image_bytes:
        return None
    try:
        import cv2

        arr = np.frombuffer(image_bytes, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            return None
        res = engine(img)
        raw_latex = res[0] if isinstance(res, tuple) else res
        if isinstance(raw_latex, str):
            cleaned = raw_latex.strip()
            if validate_latex(cleaned):
                return cleaned
    except Exception:
        logger.debug("RapidLaTeXOCR inference failed on crop; falling back.", exc_info=True)
    return None


def _render_crop_png(page: fitz.Page, rect: fitz.Rect) -> bytes | None:
    try:
        padded = fitz.Rect(rect.x0 - 3.0, rect.y0 - 2.0, rect.x1 + 3.0, rect.y1 + 2.0) & page.rect
        if padded.is_empty or padded.width < 2 or padded.height < 2:
            return None
        pixmap = page.get_pixmap(clip=padded, dpi=FORMULA_CROP_DPI)
        return pixmap.tobytes("png")
    except Exception:
        logger.exception("Failed rendering formula PNG crop on page %s", page.number + 1)
        return None


def detect_display_formulas(
    page: fitz.Page,
    page_lines: list[dict[str, Any]],
    body_size: float,
    *,
    doclayout_regions: list[dict[str, Any]] | None = None,
    table_rects: list[Any] | None = None,
    figure_rects: list[Any] | None = None,
) -> tuple[list[dict[str, Any]], set[int]]:
    """
    Detect display formulas on `page`, returning `(formulas, consumed_line_ids)`.
    Runs CPU `RapidLaTeXOCR` when available and always renders a 250 DPI PNG crop
    fallback when OCR is unavailable/fails or for complex stacked formulas.
    """
    page_number = page.number + 1
    excluded_rects = [fitz.Rect(r) for r in (table_rects or [])] + [fitz.Rect(r) for r in (figure_rects or [])]

    def _overlaps_excluded(r: fitz.Rect) -> bool:
        area = max(r.get_area(), 1.0)
        return any(r.intersect(ex).get_area() >= 0.4 * area for ex in excluded_rects)

    features = {id(l): _math_line_features(l, body_size) for l in page_lines}
    eq_num_lines = [l for l in page_lines if features[id(l)]["eq_num"] is not None and not _overlaps_excluded(fitz.Rect(l["bbox"]))]

    # Map candidate math lines to same-row equation numbers.
    eq_partner: dict[int, dict[str, Any]] = {}
    used_eq_ids: set[int] = set()
    for eq_line in eq_num_lines:
        eb = fitz.Rect(eq_line["bbox"])
        ecy = (eb.y0 + eb.y1) / 2.0
        best_partner = None
        best_dy = float("inf")
        for cand in page_lines:
            if id(cand) == id(eq_line) or cand in eq_num_lines:
                continue
            cb = fitz.Rect(cand["bbox"])
            if _overlaps_excluded(cb):
                continue
            ccy = (cb.y0 + cb.y1) / 2.0
            dy = abs(ccy - ecy)
            row_tol = max(cb.height, eb.height, body_size) * 0.95
            if dy <= row_tol and cb.x1 <= eb.x0 + 8.0 and dy < best_dy:
                best_dy = dy
                best_partner = cand
        if best_partner is not None:
            eq_partner[id(best_partner)] = eq_line
            used_eq_ids.add(id(eq_line))

    groups: list[dict[str, Any]] = []
    consumed_ids: set[int] = set()

    # Source 1: DocLayout-YOLO `isolate_formula` regions (scans / complex blocks).
    for region in (doclayout_regions or []):
        if region.get("label") != "isolate_formula":
            continue
        rbox = fitz.Rect(region["bbox"]) & page.rect
        if rbox.is_empty or _overlaps_excluded(rbox):
            continue
        inside = [
            l for l in page_lines
            if id(l) not in consumed_ids
            and fitz.Rect(l["bbox"]).intersect(rbox).get_area() >= 0.5 * max(fitz.Rect(l["bbox"]).get_area(), 1.0)
        ]
        eq_num = None
        crop_parts = []
        for l in inside:
            if features[id(l)]["eq_num"]:
                eq_num = features[id(l)]["eq_num"]
            else:
                crop_parts.append(l)
            consumed_ids.add(id(l))
        if not eq_num:
            for l in inside:
                if id(l) in eq_partner:
                    eq_line = eq_partner[id(l)]
                    eq_num = features[id(eq_line)]["eq_num"]
                    consumed_ids.add(id(eq_line))
                    break
        crop_rect = fitz.Rect(rbox)
        if crop_parts and eq_num:
            crop_rect.x1 = min(crop_rect.x1, max(l["bbox"][2] for l in crop_parts) + 4.0)
        groups.append({
            "rect": rbox,
            "crop_rect": crop_rect,
            "lines": crop_parts,
            "equation_number": eq_num,
            "from_doclayout": True,
        })

    # Source 2: Native/OCR math candidate lines grouped vertically within same column/band.
    candidates: list[dict[str, Any]] = []
    for l in page_lines:
        if id(l) in consumed_ids:
            continue
        lb = fitz.Rect(l["bbox"])
        if lb.is_empty or _overlaps_excluded(lb):
            continue
        feat = features[id(l)]
        if _is_display_math_candidate(l, feat, has_row_eq_num=(id(l) in eq_partner)):
            candidates.append(l)

    candidates.sort(key=lambda l: (l["bbox"][1], l["bbox"][0]))
    active_group: dict[str, Any] | None = None
    for cand in candidates:
        cb = fitz.Rect(cand["bbox"])
        if active_group is not None:
            prev_last = active_group["lines"][-1]
            pb = fitz.Rect(prev_last["bbox"])
            vgap = cb.y0 - pb.y1
            same_col = (
                prev_last.get("column_role") == cand.get("column_role")
                and abs(((cb.x0 + cb.x1) / 2.0) - ((pb.x0 + pb.x1) / 2.0)) < 160.0
            )
            if -pb.height <= vgap <= max(18.0, 1.8 * body_size) and same_col:
                active_group["lines"].append(cand)
                active_group["rect"] |= cb
                active_group["crop_rect"] |= cb
                consumed_ids.add(id(cand))
                continue

        if active_group is not None:
            groups.append(active_group)
        consumed_ids.add(id(cand))
        active_group = {
            "rect": fitz.Rect(cb),
            "crop_rect": fitz.Rect(cb),
            "lines": [cand],
            "equation_number": None,
            "from_doclayout": False,
        }
    if active_group is not None:
        groups.append(active_group)

    # Attach row equation numbers to line-grouped formulas.
    for grp in groups:
        if grp["equation_number"] is not None:
            continue
        for l in grp["lines"]:
            if id(l) in eq_partner:
                eq_line = eq_partner[id(l)]
                grp["equation_number"] = features[id(eq_line)]["eq_num"]
                grp["rect"] |= fitz.Rect(eq_line["bbox"])
                consumed_ids.add(id(eq_line))
                break

    formulas: list[dict[str, Any]] = []
    for grp in groups:
        rect = grp["rect"] & page.rect
        crop_rect = grp["crop_rect"] & page.rect
        if rect.is_empty or crop_rect.is_empty:
            continue

        image_bytes = _render_crop_png(page, crop_rect)
        recognized_latex = _recognize_crop_with_onnx(image_bytes) if image_bytes else None
        used_fallback = False

        if recognized_latex is None:
            grp_lines = grp["lines"]
            is_simple_native = (
                not grp["from_doclayout"]
                and len(grp_lines) == 1
                and grp_lines[0].get("source") != "ocr"
                and not features[id(grp_lines[0])]["has_pua"]
            )
            native_latex = _native_text_to_latex(grp_lines[0]["text"]) if is_simple_native else None
            if native_latex is not None:
                recognized_latex = native_latex
            else:
                used_fallback = True

        if recognized_latex is None and not image_bytes:
            # Nothing renderable or displayable for this box: release lines.
            continue

        formulas.append({
            "page": page_number,
            "bbox": rect,
            "formula_latex": recognized_latex,
            "equation_number": grp["equation_number"],
            "image_bytes": image_bytes,
            "used_fallback": used_fallback,
            "_render_page": page,
        })

    return formulas, consumed_ids


def detect_inline_formulas(text: str, raw_spans: list[tuple[str, str]] | None = None) -> list[dict[str, Any]]:
    """
    Detect non-overlapping inline formulas in cleaned block `text`, returning
    exact `[{"start", "end", "latex"}]` spans validated for KaTeX.
    """
    if not text or len(text) < 2:
        return []

    spans_out: list[dict[str, Any]] = []
    occupied: list[tuple[int, int]] = []

    def _overlaps(s: int, e: int) -> bool:
        return any(not (e <= os or s >= oe) for os, oe in occupied)

    def _add(s: int, e: int, raw_formula: str) -> None:
        if s < 0 or e <= s or e > len(text) or _overlaps(s, e):
            return
        latex = _native_text_to_latex(raw_formula)
        if latex is None:
            return
        occupied.append((s, e))
        spans_out.append({"start": s, "end": e, "latex": latex})

    for match in _INLINE_DOLLAR_RE.finditer(text):
        inner = match.group(1).strip()
        if inner and validate_latex(inner) and not _overlaps(match.start(), match.end()):
            occupied.append((match.start(), match.end()))
            spans_out.append({"start": match.start(), "end": match.end(), "latex": inner})

    for match in _INLINE_EXPR_RE.finditer(text):
        s, e = match.start(), match.end()
        raw_snippet = text[s:e]
        trimmed = raw_snippet.strip(" .,;:")
        if not trimmed or len(trimmed) < 2:
            continue
        lead = len(raw_snippet) - len(raw_snippet.lstrip(" .,;:"))
        exact_s = s + lead
        exact_e = exact_s + len(trimmed)
        # Require either non-ASCII math/Greek OR clear algebraic assignment/operator with no URL.
        if "http" in trimmed.lower() or "www." in trimmed.lower():
            continue
        if any(c in _ALL_MATH_OPERATORS for c in trimmed) or _GREEK_RANGE_RE.search(trimmed):
            _add(exact_s, exact_e, trimmed)

    if raw_spans:
        cursor = 0
        for stext, sfont in raw_spans:
            clean_piece = " ".join((stext or "").split())
            if not clean_piece:
                continue
            pos = text.find(clean_piece, cursor)
            if pos == -1:
                continue
            cursor = pos + len(clean_piece)
            if (
                _is_math_font(sfont)
                and 2 <= len(clean_piece) <= 48
                and (
                    any(c in _ALL_MATH_OPERATORS for c in clean_piece)
                    or _GREEK_RANGE_RE.search(clean_piece)
                    or ("_" in clean_piece or "^" in clean_piece)
                )
            ):
                _add(pos, cursor, clean_piece)

    spans_out.sort(key=lambda item: item["start"])
    return spans_out

"""
pdf_ocr.py
----------
CPU-first hybrid PDF page classifier, OpenCV scan preprocessor, ONNX layout/OCR
runner, and Pixel -> CropBox PDF-point coordinate projector.

Design goals (`specs/001-pdf-extraction-report-rendering/`):
- Run 100% on CPU-only Python venv hosts via `onnxruntime` (zero GPU/Docker).
- Degrade gracefully at every stage when optional external weights or binaries
  are unavailable (`DocLayout-YOLO` ONNX, custom Vietnamese ONNX, `tesseract`).
- Normalize every OCR-extracted line into exact upright visible `page.rect`
  PDF points (`0..width, 0..height`) matching `pdf.js`, setting
  `exact_position = True` so flattened and scanned PDFs get accurate Original
  PDF highlights too.
"""

from __future__ import annotations

import logging
import math
import os
import re
import shutil
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import cv2
import fitz
import numpy as np

logger = logging.getLogger(__name__)

_DEFAULT_MODEL_DIR = Path(__file__).resolve().parent / "models" / "ocr"

_ARXIV_STAMP_RE = re.compile(r"^\s*arXiv\s*:\s*\d{4}\.\d{4,5}", re.IGNORECASE)
_CONTROL_NOISE_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")

_ENGINE_LOCK = threading.Lock()
_RAPIDOCR_ENGINE: Any = None
_DOCLAYOUT_SESSION: Any = None
_VIETOCR_BUNDLE: tuple[Any, list[str]] | None = None
_DOCLAYOUT_ATTEMPTED = False
_VIETOCR_ATTEMPTED = False


def get_ocr_config() -> dict[str, Any]:
    """Resolve model paths and CPU thread settings from environment."""
    model_dir = Path(os.getenv("OCR_MODEL_DIR") or str(_DEFAULT_MODEL_DIR))
    in_pytest = bool(os.getenv("PYTEST_CURRENT_TEST"))
    auto_dl_raw = os.getenv("OCR_AUTO_DOWNLOAD")
    if auto_dl_raw is None:
        auto_download = not in_pytest
    else:
        auto_download = auto_dl_raw.strip().lower() in ("1", "true", "yes", "on")

    def _int_env(name: str, default: int) -> int:
        raw = os.getenv(name)
        if not raw:
            return default
        try:
            return max(1, int(raw))
        except ValueError:
            return default

    threads = _int_env("ORT_NUM_THREADS", _int_env("OMP_NUM_THREADS", 4))
    return {
        "model_dir": model_dir,
        "doclayout_path": Path(os.getenv("DOCLAYOUT_ONNX_PATH") or str(model_dir / "doclayout_yolo.onnx")),
        "vietocr_path": Path(os.getenv("VIETOCR_ONNX_PATH") or str(model_dir / "vietocr.onnx")),
        "vietocr_dict_path": Path(os.getenv("VIETOCR_DICT_PATH") or str(model_dir / "vietnamese_dict.txt")),
        "latex_ocr_dir": Path(os.getenv("LATEX_OCR_MODEL_DIR") or str(model_dir / "latex_ocr")),
        "auto_download": auto_download,
        "ort_threads": threads,
    }


def resolve_model_path(path: Path) -> Path | None:
    """Return `path` if present on disk; never blocks offline tests."""
    if path.exists() and path.is_file():
        return path
    return None


def _ort_session(onnx_path: Path):
    import onnxruntime as ort

    cfg = get_ocr_config()
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = cfg["ort_threads"]
    opts.inter_op_num_threads = 1
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(str(onnx_path), sess_options=opts, providers=["CPUExecutionProvider"])


def _get_rapidocr():
    global _RAPIDOCR_ENGINE
    if _RAPIDOCR_ENGINE is not None:
        return _RAPIDOCR_ENGINE
    with _ENGINE_LOCK:
        if _RAPIDOCR_ENGINE is not None:
            return _RAPIDOCR_ENGINE
        try:
            from rapidocr_onnxruntime import RapidOCR

            cfg = get_ocr_config()
            _RAPIDOCR_ENGINE = RapidOCR(
                intra_op_num_threads=cfg["ort_threads"],
                inter_op_num_threads=1,
            )
        except Exception:
            logger.exception("Could not initialize RapidOCR ONNX engine.")
            _RAPIDOCR_ENGINE = False
        return _RAPIDOCR_ENGINE


def _get_doclayout_session():
    global _DOCLAYOUT_SESSION, _DOCLAYOUT_ATTEMPTED
    if _DOCLAYOUT_ATTEMPTED:
        return _DOCLAYOUT_SESSION
    with _ENGINE_LOCK:
        if _DOCLAYOUT_ATTEMPTED:
            return _DOCLAYOUT_SESSION
        _DOCLAYOUT_ATTEMPTED = True
        path = resolve_model_path(get_ocr_config()["doclayout_path"])
        if path is not None:
            try:
                _DOCLAYOUT_SESSION = _ort_session(path)
            except Exception:
                logger.warning("Failed to load DocLayout-YOLO ONNX from %s; falling back to geometric layout.", path)
                _DOCLAYOUT_SESSION = None
        return _DOCLAYOUT_SESSION


def _get_vietocr_bundle():
    global _VIETOCR_BUNDLE, _VIETOCR_ATTEMPTED
    if _VIETOCR_ATTEMPTED:
        return _VIETOCR_BUNDLE
    with _ENGINE_LOCK:
        if _VIETOCR_ATTEMPTED:
            return _VIETOCR_BUNDLE
        _VIETOCR_ATTEMPTED = True
        cfg = get_ocr_config()
        model_path = resolve_model_path(cfg["vietocr_path"])
        dict_path = resolve_model_path(cfg["vietocr_dict_path"])
        if model_path is not None and dict_path is not None:
            try:
                chars = dict_path.read_text(encoding="utf-8").splitlines()
                chars = [c for c in chars if c != ""]
                sess = _ort_session(model_path)
                _VIETOCR_BUNDLE = (sess, ["<blank>", *chars])
            except Exception:
                logger.warning("Failed to load Vietnamese ONNX recognizer from %s.", model_path)
                _VIETOCR_BUNDLE = None
        return _VIETOCR_BUNDLE


def _has_tesseract_vie() -> bool:
    if shutil.which("tesseract") is None:
        return False
    try:
        import pytesseract

        langs = pytesseract.get_languages(config="")
        return "vie" in langs or "eng" in langs
    except Exception:
        return False


def transform_rect_to_viewport(bbox: Any, page: fitz.Page) -> fitz.Rect:
    """Transform an unrotated PyMuPDF bbox into visible CropBox-relative `page.rect`."""
    rect = fitz.Rect(bbox)
    if page.rotation:
        rect = rect * page.rotation_matrix
    return rect & page.rect


def _glyph_stats(page_dict: dict[str, Any]) -> tuple[int, float, list[fitz.Rect]]:
    printable = 0
    garbled = 0
    line_boxes: list[fitz.Rect] = []

    for block in page_dict.get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            lbox = line.get("bbox")
            line_has_printable = False
            for span in line.get("spans", []):
                text = span.get("text") or ""
                for ch in text:
                    if ch.isspace():
                        continue
                    code = ord(ch)
                    if ch == "\ufffd" or 0xE000 <= code <= 0xF8FF or _CONTROL_NOISE_RE.match(ch):
                        garbled += 1
                    elif ch.isprintable():
                        printable += 1
                        line_has_printable = True
                    else:
                        garbled += 1
            if line_has_printable and lbox:
                line_boxes.append(fitz.Rect(lbox))

    total = printable + garbled
    garbled_ratio = (garbled / total) if total > 0 else 0.0
    return printable, garbled_ratio, line_boxes


def classify_page_mode(
    page: fitz.Page,
    page_dict: dict[str, Any] | None = None,
) -> tuple[str, dict[str, Any]]:
    """
    Classify a PDF page as:
      - `"native"`: sufficient healthy Unicode text and no large uncovered text-bearing raster
      - `"ocr"`: flattened / scanned / garbled page requiring full-page OCR
      - `"hybrid"`: valid native text plus significant uncovered raster region(s)
    """
    if page_dict is None:
        page_dict = page.get_text("dict")

    printable, garbled_ratio, raw_line_boxes = _glyph_stats(page_dict)
    line_boxes = [transform_rect_to_viewport(b, page) for b in raw_line_boxes]

    page_area = max(page.rect.width * page.rect.height, 1.0)
    try:
        infos = page.get_image_info(xrefs=False)
    except Exception:
        infos = []

    uncovered_regions: list[tuple[float, float, float, float]] = []
    uncovered_area = 0.0
    max_uncovered_share = 0.0
    any_large_image = False

    for info in infos:
        rect = transform_rect_to_viewport(info["bbox"], page)
        if rect.is_empty:
            continue
        share = (rect.width * rect.height) / page_area
        if share < 0.15:
            continue
        any_large_image = True

        # Check how many native text lines sit on top of this raster image.
        overlapping_lines = 0
        for lb in line_boxes:
            cx, cy = (lb.x0 + lb.x1) / 2, (lb.y0 + lb.y1) / 2
            if rect.x0 - 2 <= cx <= rect.x1 + 2 and rect.y0 - 2 <= cy <= rect.y1 + 2:
                overlapping_lines += 1
        if overlapping_lines < 2:
            uncovered_regions.append((rect.x0, rect.y0, rect.x1, rect.y1))
            uncovered_area += share
            max_uncovered_share = max(max_uncovered_share, share)

    if printable < 30 or garbled_ratio >= 0.05 or (max_uncovered_share >= 0.80 and printable < 120):
        has_images = bool(infos) or any_large_image
        has_drawings = False
        if not has_images and printable == 0:
            try:
                has_drawings = len(page.get_cdrawings()) > 0
            except Exception:
                has_drawings = False
        if printable == 0 and not has_images and not has_drawings:
            # Truly blank page: skip expensive rasterization on fast path.
            return "native", {"printable_chars": 0, "garbled_ratio": 0.0, "ocr_regions": []}
        return "ocr", {
            "printable_chars": printable,
            "garbled_ratio": round(garbled_ratio, 4),
            "ocr_regions": [],
        }

    if uncovered_regions and (uncovered_area >= 0.25 or max_uncovered_share >= 0.50):
        return "hybrid", {
            "printable_chars": printable,
            "garbled_ratio": round(garbled_ratio, 4),
            "ocr_regions": uncovered_regions,
        }

    return "native", {"printable_chars": printable, "garbled_ratio": round(garbled_ratio, 4), "ocr_regions": []}


@dataclass
class PreprocessResult:
    image: np.ndarray
    skew_angle: float
    coarse_rotation: int
    to_orig_coords: Callable[[float, float], tuple[float, float]]


@dataclass
class PageExtractionResult:
    page_number: int
    extraction_mode: str
    width: float
    height: float
    rotation: int
    skew_angle: float
    lines: list[dict[str, Any]] = field(default_factory=list)
    tables: list[dict[str, Any]] = field(default_factory=list)
    figures: list[dict[str, Any]] = field(default_factory=list)
    formulas: list[dict[str, Any]] = field(default_factory=list)
    layout_regions: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def _estimate_skew_angle(gray: np.ndarray) -> float:
    """Estimate fine page skew in degrees within [-15, 15]."""
    if gray.shape[0] < 40 or gray.shape[1] < 40:
        return 0.0

    # Downscale moderately for fast, stable contour detection on high-DPI scans.
    scale = min(1.0, 1200.0 / max(gray.shape[:2]))
    small = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1.0 else gray

    blurred = cv2.GaussianBlur(small, (3, 3), 0)
    _, binary = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    if np.count_nonzero(binary) < 80:
        return 0.0

    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (25, 3))
    dilated = cv2.dilate(binary, kernel, iterations=1)
    contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    angles: list[float] = []
    weights: list[float] = []
    for cnt in contours:
        rect = cv2.minAreaRect(cnt)
        (rw, rh), angle = rect[1], rect[2]
        if rw < rh:
            rw, rh = rh, rw
            angle += 90.0
        if angle > 45.0:
            angle -= 90.0
        elif angle < -45.0:
            angle += 90.0
        if rw < 30 or rw < 2.2 * max(rh, 1.0) or abs(angle) > 15.0:
            continue
        angles.append(angle)
        weights.append(rw)

    if len(angles) < 2:
        return 0.0

    order = np.argsort(angles)
    cum = np.cumsum([weights[i] for i in order])
    median_idx = int(np.searchsorted(cum, cum[-1] * 0.5))
    median_angle = float(angles[order[min(median_idx, len(order) - 1)]])
    return median_angle if abs(median_angle) >= 0.35 else 0.0


def _clean_dark_borders(gray: np.ndarray) -> np.ndarray:
    """Whiten solid dark scanner edge strips (< 2.5% of dimension)."""
    h, w = gray.shape[:2]
    if h < 40 or w < 40:
        return gray
    out = gray.copy()
    max_x = max(2, int(0.025 * w))
    max_y = max(2, int(0.025 * h))

    # Left / right margins
    for col_range in (range(0, max_x), range(w - 1, w - 1 - max_x, -1)):
        for x in col_range:
            if float(np.mean(out[:, x] < 80)) > 0.85:
                out[:, x] = 255
            else:
                break
    # Top / bottom margins
    for row_range in (range(0, max_y), range(h - 1, h - 1 - max_y, -1)):
        for y in row_range:
            if float(np.mean(out[y, :] < 80)) > 0.85:
                out[y, :] = 255
            else:
                break
    return out


def preprocess_scan_image(rgb_img: np.ndarray) -> PreprocessResult:
    """
    Normalize contrast/illumination, remove dark scanner borders, detect fine
    skew, and return an upright RGB image alongside an exact inverse coordinate
    mapper back into the input image's pixels.
    """
    if rgb_img.ndim == 2:
        rgb = cv2.cvtColor(rgb_img, cv2.COLOR_GRAY2RGB)
    else:
        rgb = rgb_img

    orig_h, orig_w = rgb.shape[:2]
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)

    # Gentle illumination normalization only on dim/low-contrast scans.
    contrast = float(np.std(gray))
    mean_lum = float(np.mean(gray))
    cleaned_gray = _clean_dark_borders(gray)
    if contrast < 48.0 or mean_lum < 185.0:
        bg = cv2.medianBlur(cleaned_gray, 51) if min(orig_h, orig_w) >= 120 else np.full_like(cleaned_gray, 255)
        norm = cv2.divide(cleaned_gray, np.maximum(bg, 1), scale=255)
        work_rgb = cv2.cvtColor(norm, cv2.COLOR_GRAY2RGB)
    else:
        work_rgb = rgb.copy()

    coarse_rot = 0
    if _has_tesseract_vie() and min(orig_h, orig_w) >= 200:
        try:
            import pytesseract

            osd = pytesseract.image_to_osd(work_rgb, output_type=pytesseract.Output.DICT)
            rot = int(osd.get("rotate", 0))
            conf = float(osd.get("orientation_conf", 0.0))
            if rot in (90, 180, 270) and conf >= 3.0:
                coarse_rot = rot
        except Exception:
            coarse_rot = 0

    rot_w, rot_h = orig_w, orig_h
    if coarse_rot == 90:
        work_rgb = cv2.rotate(work_rgb, cv2.ROTATE_90_CLOCKWISE)
        rot_w, rot_h = orig_h, orig_w
    elif coarse_rot == 180:
        work_rgb = cv2.rotate(work_rgb, cv2.ROTATE_180)
    elif coarse_rot == 270:
        work_rgb = cv2.rotate(work_rgb, cv2.ROTATE_90_COUNTERCLOCKWISE)
        rot_w, rot_h = orig_h, orig_w

    gray_for_skew = cv2.cvtColor(work_rgb, cv2.COLOR_RGB2GRAY)
    skew = _estimate_skew_angle(gray_for_skew)

    inv_affine: np.ndarray | None = None
    if abs(skew) >= 0.35:
        center = (rot_w / 2.0, rot_h / 2.0)
        mat = cv2.getRotationMatrix2D(center, skew, 1.0)
        work_rgb = cv2.warpAffine(
            work_rgb,
            mat,
            (rot_w, rot_h),
            flags=cv2.INTER_CUBIC,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=(255, 255, 255),
        )
        inv_affine = cv2.invertAffineTransform(mat)

    def to_orig_coords(px: float, py: float) -> tuple[float, float]:
        ux, uy = float(px), float(py)
        if inv_affine is not None:
            nx = float(inv_affine[0, 0] * ux + inv_affine[0, 1] * uy + inv_affine[0, 2])
            ny = float(inv_affine[1, 0] * ux + inv_affine[1, 1] * uy + inv_affine[1, 2])
            ux, uy = nx, ny

        if coarse_rot == 90:
            # rotated cw: (x', y') = (orig_h - 1 - y, x) => orig (x, y) = (y', orig_h - 1 - x')
            return uy, max(0.0, (orig_h - 1) - ux)
        if coarse_rot == 180:
            return max(0.0, (orig_w - 1) - ux), max(0.0, (orig_h - 1) - uy)
        if coarse_rot == 270:
            # rotated ccw: (x', y') = (y, orig_w - 1 - x) => orig (x, y) = (orig_w - 1 - y', x')
            return max(0.0, (orig_w - 1) - uy), ux
        return ux, uy

    return PreprocessResult(
        image=work_rgb,
        skew_angle=round(skew, 2),
        coarse_rotation=coarse_rot,
        to_orig_coords=to_orig_coords,
    )


_DOCLAYOUT_LABELS = {
    0: "title",
    1: "plain_text",
    2: "abandon",
    3: "figure",
    4: "figure_caption",
    5: "table",
    6: "table_caption",
    7: "table_footnote",
    8: "isolate_formula",
    9: "formula_caption",
}


def detect_layout_regions(
    rgb_img: np.ndarray,
    page_width: float,
    page_height: float,
    dpi: int,
) -> list[dict[str, Any]] | None:
    """
    Run `DocLayout-YOLO` ONNX on CPU if weights exist; otherwise return `None`
    so callers seamlessly fall back to geometric layout segmentation.
    """
    sess = _get_doclayout_session()
    if sess is None:
        return None
    try:
        input_meta = sess.get_inputs()[0]
        target_size = 1024
        if len(input_meta.shape) >= 4 and isinstance(input_meta.shape[2], int) and input_meta.shape[2] > 0:
            target_size = input_meta.shape[2]

        h, w = rgb_img.shape[:2]
        scale = min(target_size / max(w, 1), target_size / max(h, 1))
        nw, nh = int(round(w * scale)), int(round(h * scale))
        resized = cv2.resize(rgb_img, (nw, nh), interpolation=cv2.INTER_LINEAR)
        canvas = np.full((target_size, target_size, 3), 114, dtype=np.uint8)
        canvas[:nh, :nw] = resized
        tensor = canvas.astype(np.float32) / 255.0
        tensor = np.transpose(tensor, (2, 0, 1))[None, ...]

        outputs = sess.run(None, {input_meta.name: tensor})
        raw = outputs[0]
        if raw.ndim == 3:
            raw = raw[0]
        if raw.ndim != 2 or raw.shape[1] < 6:
            return None

        pt_scale = 72.0 / float(dpi)
        regions: list[dict[str, Any]] = []
        for det in raw:
            conf = float(det[4])
            if conf < 0.30:
                continue
            cls_id = int(det[5])
            x0, y0, x1, y1 = [float(v) / scale * pt_scale for v in det[:4]]
            x0 = max(0.0, min(x0, page_width))
            y0 = max(0.0, min(y0, page_height))
            x1 = max(0.0, min(x1, page_width))
            y1 = max(0.0, min(y1, page_height))
            if x1 - x0 < 2.0 or y1 - y0 < 2.0:
                continue
            regions.append({
                "label": _DOCLAYOUT_LABELS.get(cls_id, "plain_text"),
                "bbox": [x0, y0, x1, y1],
                "score": conf,
            })
        return regions
    except Exception:
        logger.warning("DocLayout-YOLO ONNX inference failed; falling back to geometric layout.", exc_info=True)
        return None


def _run_vietocr_crop(crop_rgb: np.ndarray) -> str | None:
    bundle = _get_vietocr_bundle()
    if bundle is None:
        return None
    sess, charset = bundle
    try:
        h, w = crop_rgb.shape[:2]
        if h < 4 or w < 4:
            return None
        target_h = 32
        target_w = max(32, min(512, int(round(w * target_h / max(h, 1)))))
        resized = cv2.resize(crop_rgb, (target_w, target_h), interpolation=cv2.INTER_LINEAR)
        tensor = (resized.astype(np.float32) / 255.0 - 0.5) / 0.5
        tensor = np.transpose(tensor, (2, 0, 1))[None, ...]
        input_name = sess.get_inputs()[0].name
        logits = sess.run(None, {input_name: tensor})[0]
        if logits.ndim == 3:
            logits = logits[0]
        indices = np.argmax(logits, axis=-1)
        chars: list[str] = []
        prev = 0
        for idx in indices:
            idx_int = int(idx)
            if idx_int != 0 and idx_int != prev and idx_int < len(charset):
                chars.append(charset[idx_int])
            prev = idx_int
        text = "".join(chars).strip()
        return text or None
    except Exception:
        return None


def _run_tesseract_ocr(
    rgb_img: np.ndarray,
    *,
    to_orig_coords: Callable[[float, float], tuple[float, float]],
    region_offset: tuple[float, float],
    page_number: int,
    page_width: float,
    page_height: float,
    dpi: int,
) -> list[dict[str, Any]]:
    import pytesseract

    langs = pytesseract.get_languages(config="")
    lang = "vie+eng" if "vie" in langs else "eng"
    data = pytesseract.image_to_data(rgb_img, lang=lang, output_type=pytesseract.Output.DICT)
    pt_scale = 72.0 / float(dpi)
    ox, oy = region_offset

    words: list[dict[str, Any]] = []
    n = len(data.get("text", []))
    for i in range(n):
        word = (data["text"][i] or "").strip()
        if not word:
            continue
        conf = float(data["conf"][i]) if str(data["conf"][i]).lstrip("-").isdigit() else -1.0
        if conf < 15.0:
            continue
        lx, ly, lw, lh = float(data["left"][i]), float(data["top"][i]), float(data["width"][i]), float(data["height"][i])
        if lw < 1 or lh < 1:
            continue
        pts = [
            to_orig_coords(lx, ly),
            to_orig_coords(lx + lw, ly),
            to_orig_coords(lx + lw, ly + lh),
            to_orig_coords(lx, ly + lh),
        ]
        px0 = max(0.0, min((min(p[0] for p in pts) + ox) * pt_scale, page_width))
        py0 = max(0.0, min((min(p[1] for p in pts) + oy) * pt_scale, page_height))
        px1 = max(0.0, min((max(p[0] for p in pts) + ox) * pt_scale, page_width))
        py1 = max(0.0, min((max(p[1] for p in pts) + oy) * pt_scale, page_height))
        if px1 - px0 < 1.0 or py1 - py0 < 1.0:
            continue
        words.append({
            "bbox": [px0, py0, px1, py1],
            "text": word,
            "block_num": data.get("block_num", [0])[i],
            "par_num": data.get("par_num", [0])[i],
            "line_num": data.get("line_num", [0])[i],
        })

    grouped: dict[tuple[int, int, int], list[dict[str, Any]]] = {}
    for w_item in words:
        key = (int(w_item["block_num"]), int(w_item["par_num"]), int(w_item["line_num"]))
        grouped.setdefault(key, []).append(w_item)

    raw_lines: list[dict[str, Any]] = []
    for key, line_words in grouped.items():
        line_words.sort(key=lambda item: item["bbox"][0])
        bbox = [
            min(item["bbox"][0] for item in line_words),
            min(item["bbox"][1] for item in line_words),
            max(item["bbox"][2] for item in line_words),
            max(item["bbox"][3] for item in line_words),
        ]
        text = " ".join(item["text"] for item in line_words).strip()
        if not text:
            continue
        raw_lines.append({
            "bbox": bbox,
            "text": text,
            "size": max(6.0, (bbox[3] - bbox[1]) * 0.85),
            "page": page_number,
            "page_height": page_height,
        })
    return _assign_ocr_blocks(raw_lines, page_number, page_width, page_height)


def _is_vertical_margin_stamp(bbox: list[float], text: str, page_width: float) -> bool:
    if _ARXIV_STAMP_RE.match(text):
        return True
    bw = bbox[2] - bbox[0]
    bh = bbox[3] - bbox[1]
    near_side_edge = bbox[2] <= 0.08 * page_width or bbox[0] >= 0.92 * page_width
    return near_side_edge and bh > 2.2 * max(bw, 1.0)


def _assign_ocr_blocks(
    lines: list[dict[str, Any]],
    page_number: int,
    page_width: float,
    page_height: float,
) -> list[dict[str, Any]]:
    """
    Keep reading-compatible OCR lines, drop vertical margin stamps, and group
    vertically contiguous same-column lines into `ocr_p{page}_b{idx}` blocks so
    `pdf_layout.reading_order()` cleanly segments multi-column pages.
    """
    kept = [l for l in lines if not _is_vertical_margin_stamp(l["bbox"], l["text"], page_width)]
    if not kept:
        return []

    kept.sort(key=lambda l: (round(l["bbox"][1], 1), l["bbox"][0]))

    groups: list[list[dict[str, Any]]] = []
    for line in kept:
        x0, y0, x1, y1 = line["bbox"]
        size = line["size"]
        placed = False
        for group in reversed(groups):
            prev = group[-1]
            px0, py0, px1, py1 = prev["bbox"]
            # Separate left/right column blocks cleanly by horizontal overlap or column alignment.
            vgap = y0 - py1
            h_overlap = min(x1, px1) - max(x0, px0)
            same_col = h_overlap > 0 or abs(x0 - px0) < 2.8 * size
            if same_col and -0.4 * size <= vgap <= 1.6 * size:
                group.append(line)
                placed = True
                break
        if not placed:
            groups.append([line])

    out: list[dict[str, Any]] = []
    for block_idx, group in enumerate(groups):
        block_id = f"{page_number}:ocr_{block_idx}"
        bx0 = min(l["bbox"][0] for l in group)
        bx1 = max(l["bbox"][2] for l in group)
        for line in group:
            size = line["size"]
            text = line["text"].strip()
            if not text:
                continue
            out.append({
                "page": page_number,
                "block": block_id,
                "bbox": list(line["bbox"]),
                "size": round(size, 2),
                "spans": [{
                    "text": text,
                    "size": round(size, 2),
                    "font": "OCR",
                    "flags": 0,
                }],
                "text": text,
                "block_x0": bx0,
                "block_x1": bx1,
                "page_height": page_height,
                "exact_position": True,
                "source": "ocr",
            })
    return out


def ocr_image_lines(
    rgb_img: np.ndarray,
    *,
    page_number: int,
    page_width: float,
    page_height: float,
    dpi: int,
    to_orig_coords: Callable[[float, float], tuple[float, float]] | None = None,
    region_offset: tuple[float, float] = (0.0, 0.0),
) -> list[dict[str, Any]]:
    """
    Detect and recognize text lines from `rgb_img` using CPU ONNX (`RapidOCR` +
    optional custom Vietnamese ONNX recognizer) or lightweight Tesseract `vie+eng`,
    emitting lines normalized to CropBox-relative PDF points.
    """
    mapper = to_orig_coords or (lambda x, y: (x, y))
    ox, oy = region_offset
    pt_scale = 72.0 / float(dpi)

    # Prefer Tesseract `vie+eng` when custom VietOCR ONNX weights are not installed
    # and the local system has Tesseract Vietnamese installed (preserves stacked diacritics).
    vietocr_ready = _get_vietocr_bundle() is not None
    if not vietocr_ready and _has_tesseract_vie():
        try:
            tess_lines = _run_tesseract_ocr(
                rgb_img,
                to_orig_coords=mapper,
                region_offset=region_offset,
                page_number=page_number,
                page_width=page_width,
                page_height=page_height,
                dpi=dpi,
            )
            if tess_lines:
                return tess_lines
        except Exception:
            logger.warning("Tesseract OCR fallback failed on page %d; falling back to RapidOCR ONNX.", page_number)

    engine = _get_rapidocr()
    if not engine or engine is False:
        return []

    bgr_img = cv2.cvtColor(rgb_img, cv2.COLOR_RGB2BGR)
    try:
        result, _ = engine(bgr_img)
    except Exception:
        logger.exception("RapidOCR inference failed on page %d.", page_number)
        return []

    if not result:
        return []

    raw_lines: list[dict[str, Any]] = []
    img_h, img_w = rgb_img.shape[:2]

    for item in result:
        if not item or len(item) < 3:
            continue
        quad, text, score = item[0], str(item[1] or "").strip(), float(item[2] or 0.0)
        if vietocr_ready and quad:
            qx0 = max(0, int(math.floor(min(p[0] for p in quad))) - 2)
            qy0 = max(0, int(math.floor(min(p[1] for p in quad))) - 2)
            qx1 = min(img_w, int(math.ceil(max(p[0] for p in quad))) + 2)
            qy1 = min(img_h, int(math.ceil(max(p[1] for p in quad))) + 2)
            if qx1 > qx0 + 4 and qy1 > qy0 + 4:
                viet_text = _run_vietocr_crop(rgb_img[qy0:qy1, qx0:qx1])
                if viet_text:
                    text = viet_text
        if not text or score < 0.20:
            continue
        if not quad or len(quad) < 4:
            continue
        # Skip severely vertical detections (e.g. rotated margin watermarks).
        det_w = max(p[0] for p in quad) - min(p[0] for p in quad)
        det_h = max(p[1] for p in quad) - min(p[1] for p in quad)
        if det_h > 2.4 * max(det_w, 1.0):
            continue

        orig_pts = [mapper(float(p[0]), float(p[1])) for p in quad]
        px0 = max(0.0, min((min(p[0] for p in orig_pts) + ox) * pt_scale, page_width))
        py0 = max(0.0, min((min(p[1] for p in orig_pts) + oy) * pt_scale, page_height))
        px1 = max(0.0, min((max(p[0] for p in orig_pts) + ox) * pt_scale, page_width))
        py1 = max(0.0, min((max(p[1] for p in orig_pts) + oy) * pt_scale, page_height))
        if px1 - px0 < 1.0 or py1 - py0 < 1.0:
            continue

        raw_lines.append({
            "bbox": [px0, py0, px1, py1],
            "text": " ".join(text.split()),
            "size": max(6.0, (py1 - py0) * 0.85),
            "page": page_number,
            "page_height": page_height,
        })

    return _assign_ocr_blocks(raw_lines, page_number, page_width, page_height)


def _render_page_rgb(page: fitz.Page, clip: fitz.Rect | None = None, target_dpi: int = 200) -> tuple[np.ndarray, int]:
    rect = clip if clip is not None else page.rect
    longest_pt = max(rect.width, rect.height, 1.0)
    capped_dpi = min(target_dpi, max(72, int(3000 * 72.0 / longest_pt)))
    pix = page.get_pixmap(clip=rect, dpi=capped_dpi, colorspace=fitz.csRGB, alpha=False)
    arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3).copy()
    return arr, capped_dpi


def extract_page_with_ocr(
    page: fitz.Page,
    page_number: int,
    *,
    mode: str = "ocr",
    ocr_regions: list[tuple[float, float, float, float]] | None = None,
) -> PageExtractionResult:
    """
    Extract lines (plus optional DocLayout-YOLO regions and page warnings) from a
    flattened/scanned page (`mode == "ocr"`) or uncovered raster sub-regions on a
    mixed page (`mode == "hybrid"`).
    """
    width = float(page.rect.width)
    height = float(page.rect.height)
    rotation = int(page.rotation or 0) % 360
    warnings: list[str] = []

    if mode == "hybrid" and ocr_regions:
        merged_lines: list[dict[str, Any]] = []
        max_skew = 0.0
        for reg in ocr_regions:
            clip = fitz.Rect(reg) & page.rect
            if clip.is_empty or clip.width < 10 or clip.height < 10:
                continue
            rgb, dpi = _render_page_rgb(page, clip=clip, target_dpi=200)
            pre = preprocess_scan_image(rgb)
            max_skew = max(max_skew, abs(pre.skew_angle))
            ox = clip.x0 * (dpi / 72.0)
            oy = clip.y0 * (dpi / 72.0)
            merged_lines.extend(
                ocr_image_lines(
                    pre.image,
                    page_number=page_number,
                    page_width=width,
                    page_height=height,
                    dpi=dpi,
                    to_orig_coords=pre.to_orig_coords,
                    region_offset=(ox, oy),
                )
            )
        return PageExtractionResult(
            page_number=page_number,
            extraction_mode="hybrid",
            width=width,
            height=height,
            rotation=rotation,
            skew_angle=max_skew,
            lines=merged_lines,
            warnings=warnings,
        )

    # Probe contrast at 150 DPI first or render adaptive DPI: digital scans are
    # clean at 200 DPI; low-contrast scans upgrade to 300 DPI for diacritic fidelity.
    rgb, dpi = _render_page_rgb(page, target_dpi=200)
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    ink_ratio = float(np.mean(gray < 200))
    if float(np.std(gray)) < 48.0 and ink_ratio > 0.002:
        rgb, dpi = _render_page_rgb(page, target_dpi=300)

    pre = preprocess_scan_image(rgb)
    layout_regions = detect_layout_regions(pre.image, width, height, dpi)

    lines = ocr_image_lines(
        pre.image,
        page_number=page_number,
        page_width=width,
        page_height=height,
        dpi=dpi,
        to_orig_coords=pre.to_orig_coords,
    )

    if layout_regions:
        abandon_boxes = [fitz.Rect(r["bbox"]) for r in layout_regions if r.get("label") == "abandon"]
        if abandon_boxes:
            filtered: list[dict[str, Any]] = []
            for line in lines:
                lb = fitz.Rect(line["bbox"])
                lb_area = max(lb.get_area(), 1.0)
                if any(lb.intersect(ab).get_area() >= 0.5 * lb_area for ab in abandon_boxes):
                    continue
                filtered.append(line)
            lines = filtered

    total_chars = sum(len(re.sub(r"\s+", "", l.get("text") or "")) for l in lines)
    if total_chars == 0 and ink_ratio > 0.002:
        warnings.append(f"page_{page_number}_illegible_scan")

    return PageExtractionResult(
        page_number=page_number,
        extraction_mode="ocr",
        width=width,
        height=height,
        rotation=rotation,
        skew_angle=pre.skew_angle,
        lines=lines,
        layout_regions=layout_regions or [],
        warnings=warnings,
    )

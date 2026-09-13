"""
marker_preview.py
------------------
Converts an already-checked PDF into a display-friendly "document" preview
(HTML, for the Report page's Original view) plus a real downloadable .docx —
using marker-pdf (https://github.com/datalab-to/marker).

This module is entirely ADDITIVE and deliberately isolated from the existing
extraction/matching pipeline (extractor.py, document_model.py, main.py):
it is never imported by them, and nothing here feeds back into the
plagiarism score or the Document view (DocumentCanvas), which keep using
extractor.py's PyMuPDF-based extraction exactly as before. This file only
produces a nicer *visual* stand-in for the raw-PDF preview
(PlagiarismPdfViewer on the frontend).

Why a subprocess into a separate venv (`marker_env/`) instead of an import:
marker-pdf pins its own torch/transformers versions, which conflict with the
pipeline's pinned torch==2.5.1/transformers==4.46.3 (backend/requirements.txt).
Installing marker-pdf into the main venv risks silently upgrading those and
breaking the embedding/local-LLM pipeline. Running it as an external tool in
its own venv (like calling `pandoc`) keeps the two dependency trees fully
isolated — the main venv/requirements.txt need no changes.

Setup (one-time, per machine — see docs/SETUP_MARKER.md):
    cd backend
    python -m venv marker_env
    marker_env/Scripts/pip install marker-pdf        # Windows
    marker_env/bin/pip install marker-pdf            # Linux/macOS
    # marker's "balanced" mode (best accuracy, needed for equations) spawns
    # a vLLM server via Docker on first use — Docker must be installed and
    # running. Falls back to raising MarkerUnavailable if it can't reach it
    # (see run_marker_conversion's except-branch below); callers treat that
    # as "no preview today", never as a hard failure of the check itself.
"""

from __future__ import annotations

import base64
import logging
import mimetypes
import os
import re
import shutil
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)

BACKEND_DIR = Path(__file__).parent
MARKER_ENV_DIR = BACKEND_DIR / "marker_env"

# Conversion mode: "balanced" (VLM layout + OCR, needs Docker+GPU, best
# accuracy — see docs/SETUP_MARKER.md) or "fast" (CPU-only heuristics, no extra
# infra, weaker on math). Overridable via env var without a code change.
MARKER_MODE = os.getenv("MARKER_MODE", "balanced")

# How long a single conversion may run before being treated as failed.
# marker's own first-run model download can take a while; subsequent runs
# are much faster. Generous on purpose — this runs in a background thread,
# never blocking the user-facing check itself.
MARKER_TIMEOUT_SECONDS = int(os.getenv("MARKER_TIMEOUT_SECONDS", "900"))

# Without this, surya (marker's balanced-mode VLM backend) tears its vLLM
# Docker container down after every single conversion and re-spawns a fresh
# one on the next — paying the ~1-2 minute engine-init/CUDA-graph/
# torch.compile warmup cost (see docs/SETUP_MARKER.md) on EVERY report, not
# just the first. Defaulting this on trades that recurring latency for the
# container (and its GPU memory) staying up continuously in the background;
# set MARKER_KEEP_ALIVE=false to opt back out of that tradeoff.
MARKER_KEEP_ALIVE = os.getenv("MARKER_KEEP_ALIVE", "true").lower() not in ("false", "0", "")

_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}


class MarkerUnavailable(Exception):
    """Raised when marker-pdf isn't set up on this machine, or a conversion
    fails outright. Callers must treat this as "no preview available today"
    — never as a reason to fail the underlying plagiarism check."""


def _marker_single_script() -> Path:
    windows_exe = MARKER_ENV_DIR / "Scripts" / "marker_single.exe"
    posix_exe = MARKER_ENV_DIR / "bin" / "marker_single"
    if windows_exe.exists():
        return windows_exe
    if posix_exe.exists():
        return posix_exe
    raise MarkerUnavailable(
        f"marker_single not found under {MARKER_ENV_DIR}. Is marker-pdf installed there?"
    )


def convert_pdf_to_markdown(pdf_path: Path, work_dir: Path, *, mode: str | None = None) -> Path:
    """
    Runs marker-pdf (in its isolated venv) on `pdf_path`, writing Markdown
    + any extracted images under `work_dir`. Returns the path to the
    produced .md file.

    Raises MarkerUnavailable on any failure (missing venv, Docker/vLLM not
    reachable for balanced mode, conversion error, timeout) — callers
    degrade to "no preview" rather than propagate.
    """
    work_dir.mkdir(parents=True, exist_ok=True)
    marker_single = _marker_single_script()
    effective_mode = mode or MARKER_MODE

    cmd = [
        str(marker_single),
        str(pdf_path),
        "--output_dir", str(work_dir),
        "--output_format", "markdown",
        "--mode", effective_mode,
    ]

    env = {**os.environ, "SURYA_INFERENCE_KEEP_ALIVE": "true"} if MARKER_KEEP_ALIVE else None

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=MARKER_TIMEOUT_SECONDS,
            cwd=str(BACKEND_DIR),
            env=env,
        )
    except subprocess.TimeoutExpired as exc:
        raise MarkerUnavailable(f"marker-pdf conversion timed out after {MARKER_TIMEOUT_SECONDS}s") from exc
    except OSError as exc:
        raise MarkerUnavailable(f"Failed to launch marker-pdf: {exc}") from exc

    if result.returncode != 0:
        logger.warning("marker-pdf failed (exit %s): %s", result.returncode, result.stderr[-4000:])
        raise MarkerUnavailable(f"marker-pdf exited with code {result.returncode}")

    # marker writes <work_dir>/<pdf_stem>/<pdf_stem>.md (plus any images
    # alongside it in the same subfolder).
    stem = pdf_path.stem
    md_path = work_dir / stem / f"{stem}.md"
    if not md_path.exists():
        # Fall back to searching, in case marker's naming changes across
        # versions — better than a hard failure over a cosmetic mismatch.
        candidates = list(work_dir.rglob("*.md"))
        if not candidates:
            raise MarkerUnavailable("marker-pdf produced no markdown output.")
        md_path = candidates[0]

    return md_path


def _guess_mime(path: Path) -> str:
    mime, _ = mimetypes.guess_type(str(path))
    return mime or "application/octet-stream"


def render_html_with_embedded_images(md_path: Path) -> str:
    """
    Converts the Markdown marker produced into standalone HTML with every
    referenced local image inlined as a base64 data: URI — so the frontend
    can render the preview with a single string, no separate image-hosting
    endpoint or Storage upload needed for this additive feature.

    Uses the stdlib-adjacent `markdown` package (see requirements.txt) —
    intentionally NOT run inside marker_env, since this step has no
    dependency-conflict risk and keeping it in-process avoids a second
    subprocess round-trip per conversion.
    """
    import markdown  # local import: keeps this an optional dependency only
    # exercised on the marker-preview path.

    text = md_path.read_text(encoding="utf-8")
    base_dir = md_path.parent

    def _inline_image(match: "re.Match[str]") -> str:
        alt, src = match.group(1), match.group(2)
        # Leave remote URLs alone; only inline local files marker wrote.
        if src.startswith("http://") or src.startswith("https://") or src.startswith("data:"):
            return match.group(0)
        image_path = (base_dir / src).resolve()
        try:
            if base_dir.resolve() not in image_path.parents and image_path != base_dir.resolve():
                return match.group(0)
            if image_path.suffix.lower() not in _IMAGE_EXTENSIONS or not image_path.is_file():
                return match.group(0)
            data = base64.b64encode(image_path.read_bytes()).decode("ascii")
            mime = _guess_mime(image_path)
            return f"![{alt}](data:{mime};base64,{data})"
        except OSError:
            return match.group(0)

    text = re.sub(r"!\[([^\]]*)\]\(([^)]+)\)", _inline_image, text)

    html_body = markdown.markdown(
        text, extensions=["tables", "fenced_code"]
    )
    return html_body


# Fallback locations checked when `pandoc` isn't resolvable via PATH — e.g.
# right after a winget install, whose registry PATH update doesn't reach a
# process (like this backend) that was already running before the install.
# A machine restart or fresh process makes this unnecessary, but a stale
# PATH shouldn't be a hard outage for a feature that otherwise works fine.
_PANDOC_FALLBACK_PATHS = [
    Path.home() / "AppData" / "Local" / "Pandoc" / "pandoc.exe",
    Path("/usr/local/bin/pandoc"),
    Path("/usr/bin/pandoc"),
]


def _resolve_pandoc() -> str:
    found = shutil.which("pandoc")
    if found:
        return found
    for candidate in _PANDOC_FALLBACK_PATHS:
        if candidate.is_file():
            return str(candidate)
    raise MarkerUnavailable(
        "pandoc is not installed or not on PATH. See docs/SETUP_MARKER.md."
    )


def convert_markdown_to_docx(md_path: Path, docx_path: Path) -> None:
    """
    Converts marker's Markdown into a real .docx via Pandoc (a system
    binary, installed separately — see docs/SETUP_MARKER.md — not part of
    either Python venv, so it carries no dependency-conflict risk of its
    own). `--resource-path` lets Pandoc resolve the image files marker
    saved next to the .md file.
    """
    pandoc = _resolve_pandoc()

    docx_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        pandoc,
        str(md_path),
        "-o", str(docx_path),
        f"--resource-path={md_path.parent}",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    except subprocess.TimeoutExpired as exc:
        raise MarkerUnavailable("pandoc Markdown→docx conversion timed out") from exc
    except OSError as exc:
        raise MarkerUnavailable(f"Failed to launch pandoc: {exc}") from exc

    if result.returncode != 0 or not docx_path.exists():
        logger.warning("pandoc failed (exit %s): %s", result.returncode, result.stderr[-4000:])
        raise MarkerUnavailable(f"pandoc exited with code {result.returncode}")


def build_marker_preview(pdf_path: Path, work_dir: Path) -> dict:
    """
    Full pipeline for one PDF: marker convert -> HTML (embedded images) +
    real .docx. Returns {"html": str, "docx_path": Path}. Raises
    MarkerUnavailable on any step's failure — callers must catch this and
    degrade gracefully (see api/app.py's run_marker_preview_job).
    """
    md_path = convert_pdf_to_markdown(pdf_path, work_dir)
    html = render_html_with_embedded_images(md_path)
    docx_path = work_dir / "preview.docx"
    convert_markdown_to_docx(md_path, docx_path)
    return {"html": html, "docx_path": docx_path}

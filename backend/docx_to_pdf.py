"""
docx_to_pdf.py
--------------
A PDF rendering of an uploaded .docx, so a Word document gets the same
Original view (the page as laid out, with highlights) a PDF upload has.

Uses LibreOffice in headless mode. LibreOffice is optional: when it isn't
installed the conversion is skipped and the report simply has no Original
view, as before. Install it on the server with

    apt-get install -y --no-install-recommends libreoffice-writer

or point LIBREOFFICE_BIN at an existing `soffice` binary.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

logger = logging.getLogger(__name__)

# A conversion that takes longer than this is stuck (a huge or broken file);
# the check itself has already finished, so it is given up on.
CONVERT_TIMEOUT_SECONDS = 120


def libreoffice_binary() -> str | None:
    configured = os.getenv("LIBREOFFICE_BIN")
    if configured:
        return configured if Path(configured).exists() else None
    return shutil.which("soffice") or shutil.which("libreoffice")


def convert_docx_to_pdf(docx_path: str | Path, out_dir: str | Path) -> Path | None:
    """
    Convert `docx_path` to a PDF in `out_dir`. Returns its path, or None when
    LibreOffice is missing or the conversion fails. Never raises.
    """
    binary = libreoffice_binary()
    if binary is None:
        logger.info("LibreOffice is not installed; %s gets no Original view.", docx_path)
        return None
    docx_path, out_dir = Path(docx_path), Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    # A profile per conversion: LibreOffice refuses to run twice at once on
    # the same profile, and checks run in parallel.
    with tempfile.TemporaryDirectory(prefix="lo-profile-") as profile:
        command = [
            binary,
            f"-env:UserInstallation={Path(profile).as_uri()}",
            "--headless", "--norestore", "--nologo",
            "--convert-to", "pdf",
            "--outdir", str(out_dir),
            str(docx_path),
        ]
        try:
            subprocess.run(
                command, check=True, timeout=CONVERT_TIMEOUT_SECONDS,
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            )
        except subprocess.TimeoutExpired:
            logger.warning("LibreOffice took too long converting %s; skipping.", docx_path)
            return None
        except (OSError, subprocess.CalledProcessError) as exc:
            stderr = getattr(exc, "stderr", b"") or b""
            logger.warning(
                "LibreOffice could not convert %s: %s %s",
                docx_path, exc, stderr.decode("utf-8", "replace")[-500:],
            )
            return None
    converted = out_dir / f"{docx_path.stem}.pdf"
    if not converted.exists() or converted.stat().st_size == 0:
        logger.warning("LibreOffice produced no PDF for %s.", docx_path)
        return None
    return converted

# marker-pdf document preview — setup

This powers the Report page's **Original** view (`MarkerDocumentViewer.tsx`):
instead of rendering the raw uploaded PDF, it shows a cleaner, reflowed
document rendering produced by [marker-pdf](https://github.com/datalab-to/marker),
plus a real downloadable `.docx`.

It is **entirely additive**: `extractor.py`, `document_model.py`, and the
plagiarism-matching pipeline in `main.py` are untouched. This feature runs as
a background thread *after* a PDF check already succeeded (see
`run_marker_preview_job` in `api/app.py`), and a failure here never fails or
retries the underlying check — it just means no nicer preview shows up for
that report (`MarkerDocumentViewer` degrades to a plain message).

## Why an isolated venv

marker-pdf pins its own `torch`/`transformers` versions, which conflict with
this project's pinned `torch==2.5.1` / `transformers==4.46.3`
(`requirements.txt` — the embedding + local-LLM pipeline). Installing
marker-pdf into the main venv risks silently upgrading those and breaking
that pipeline. Instead, marker-pdf lives in its own venv
(`backend/marker_env/`) and is invoked as an external tool via subprocess
(`marker_preview.py`), exactly like this project already shells out to
Pandoc — never imported into the main process.

## One-time setup

```bash
cd backend
python -m venv marker_env

# Windows
marker_env\Scripts\pip install marker-pdf
# Linux/macOS
marker_env/bin/pip install marker-pdf
```

### GPU support

The venv's default `pip install torch` may land a CPU-only build depending
on platform/index. Verify:

```bash
marker_env/Scripts/python -c "import torch; print(torch.cuda.is_available())"
```

If `False` on a machine with an NVIDIA GPU, reinstall against a CUDA wheel
index matching the installed driver, e.g.:

```bash
marker_env/Scripts/pip install --force-reinstall "torch>=2.7.0,<3" torchvision --index-url https://download.pytorch.org/whl/cu128
marker_env/Scripts/pip install "pillow>=10.1.0,<11"   # marker-pdf pins pillow<11; the torch reinstall usually pulls in a newer one
```

Pick the `cuXXX` index matching your driver from
https://pytorch.org/get-started/locally/ — marker-pdf currently requires
`torch>=2.7.0`.

### Pandoc

The real, downloadable `.docx` is produced by converting marker's Markdown
output with [Pandoc](https://pandoc.org/) — a plain system binary, not part
of either Python venv:

```powershell
winget install --id JohnMacFarlane.Pandoc -e
```

```bash
# Debian/Ubuntu
sudo apt-get install pandoc
```

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `MARKER_MODE` | `fast` | Runs marker's lightweight in-process detectors with no external daemon required |
| `MARKER_DEVICE` | marker's choice; `cpu` below `MARKER_GPU_MIN_VRAM_GB` | Passed to marker as `TORCH_DEVICE` |
| `MARKER_GPU_MIN_VRAM_GB` | `20` | Smaller cards keep the preview off the GPU — see `GPU_MEMORY.md` |
| `MARKER_TIMEOUT_SECONDS` | `900` | Max seconds for one PDF's marker conversion before it's treated as failed |
| `MARKER_PREVIEW_DIR` | `./storage/marker_previews` | Where per-report HTML/docx output is kept (local disk only — see `marker_preview_store.py`'s docstring on the durability tradeoff, same as `job_manager.py`'s in-memory jobs) |

## Verifying the setup works

```bash
cd backend
marker_env/bin/marker_single some-paper.pdf --output_dir /tmp/marker_test --output_format markdown --mode fast
```

First run downloads model weights into the local cache. Subsequent runs are
much faster. If this succeeds and produces a `.md` file, the backend's
`/api/reports/{id}/marker-preview` endpoint will work the same way.

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

### Docker (required for `MARKER_MODE=balanced`, the default)

marker-pdf's high-accuracy **balanced** mode (needed for readable equations —
see the accuracy discussion this feature was scoped from) runs its
layout/OCR model via a vLLM server that marker **auto-spawns in a Docker
container** on first use. Requirements:

- Docker Desktop installed and **running** (the daemon, not just the app
  installed).
- GPU passthrough working: `docker run --rm --gpus all
  nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi` should print your GPU.
- First conversion pulls the vLLM image and downloads the OCR model from
  Hugging Face — expect several GB and a few minutes the first time only.
  The container (`surya-vllm-<port>`) then stays up in the background for
  subsequent conversions.

**No Docker / no GPU?** Set `MARKER_MODE=fast` in the backend's environment.
This uses lightweight CPU detectors instead — works with zero extra infra,
but is noticeably weaker on math-heavy papers (equations render far less
reliably; plain text/tables/headings are still fine). See `marker_preview.py`.

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
| `MARKER_MODE` | `balanced` | `balanced` (Docker+vLLM, best accuracy) or `fast` (CPU-only, no extra infra) |
| `MARKER_TIMEOUT_SECONDS` | `900` | Max seconds for one PDF's marker conversion before it's treated as failed |
| `MARKER_PREVIEW_DIR` | `./storage/marker_previews` | Where per-report HTML/docx output is kept (local disk only — see `marker_preview_store.py`'s docstring on the durability tradeoff, same as `job_manager.py`'s in-memory jobs) |
| `MARKER_KEEP_ALIVE` | `true` | Keeps the vLLM Docker container (`balanced` mode) running between conversions instead of tearing it down after each one. Without this, **every** conversion re-pays a ~1-2 minute engine-init/CUDA-graph/torch.compile warmup (confirmed while building this feature — the model weights themselves are cached on disk via a mounted volume and are NOT re-downloaded, only the warmup repeats). The tradeoff: the container (and its GPU memory) stays resident continuously in the background. Set to `false` to opt out. |

## Verifying the setup works

```bash
cd backend
marker_env\Scripts\marker_single.exe some-paper.pdf --output_dir /tmp/marker_test --output_format markdown --mode balanced
```

First run: Docker pulls the vLLM image + downloads model weights (can take
several minutes). Subsequent runs reuse the running container and are much
faster. If this succeeds and produces a `.md` file, the backend's
`/api/reports/{id}/marker-preview` endpoint will work the same way.

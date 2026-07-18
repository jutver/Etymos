# CUDA-capable base image: the deployment VPS (n1.ckey.vn) has an NVIDIA
# GPU and runs the local Qwen2.5-1.5B metadata-extraction model (torch +
# bitsandbytes) alongside the Gemini API path (see PLAN.md Phase 1/2). The
# CUDA runtime + cuDNN libraries here are what torch/bitsandbytes' GPU
# detection look for inside the container; the NVIDIA driver itself is
# passed through from the host by the NVIDIA Container Toolkit via
# docker-compose.yml's `deploy.resources.reservations.devices` block — this
# image intentionally does NOT force a CPU-only torch build.
FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

# Single stage: torch/transformers/bitsandbytes are the bulk of the image
# regardless of how the build is split, and this repo has one deployable
# service (no separate build-time-only toolchain to shed), so a multi-stage
# build would add complexity without shrinking the image meaningfully.

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# Ubuntu 22.04's apt Python is 3.10, compatible with the torch==2.5.1 /
# transformers==4.46.3 pins in requirements.txt. curl is required by
# docker-compose.yml's healthcheck (`curl -f http://localhost:8000/api/health`).
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.10 \
        python3-pip \
        curl \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3.10 /usr/bin/python3 \
    && ln -sf /usr/bin/python3 /usr/bin/python

# backend/api/app.py does
#   sys.path.append(str(Path(__file__).parent.parent))
# at import time, so it can import sibling modules that live directly in
# backend/ (main.py, doan_van.py, llm_metadata.py, job_manager.py,
# report_store.py, config.py, supabase_client.py, auth.py, ...). Copying the
# whole backend/ tree to /app and setting WORKDIR there means:
#   - `api` resolves as a package rooted at /app (api/__init__.py exists),
#     so `uvicorn api.app:app` finds it;
#   - app.py's own sys.path.append then makes the backend/-level sibling
#     modules importable.
# PYTHONPATH is set explicitly (belt-and-suspenders on top of cwd-based
# resolution) so `python3 -m api.app`-style invocations work the same way.
WORKDIR /app
ENV PYTHONPATH=/app

# Install dependencies before copying source so this (expensive) layer is
# cached across code-only changes.
COPY requirements.txt .
RUN python3 -m pip install --upgrade pip \
    && python3 -m pip install -r requirements.txt

# Copy the rest of the backend (api/, main.py, doan_van.py, llm_metadata.py,
# config.py, search_paper/, tests/, etc).
COPY . .

EXPOSE 8000

CMD ["uvicorn", "api.app:app", "--host", "0.0.0.0", "--port", "8000"]

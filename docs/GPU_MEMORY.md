# GPU memory: running on a 12 GB card

The backend runs on a 24 GB card (RTX 3090) and on a 12 GB one with no code
change. `backend/gpu_models.py` loads each model the first time it's needed
and keeps the total under a VRAM budget. When a model that isn't loaded
won't fit, it unloads the idle model that has gone unused longest.

## The models

| Name in logs | Model | Used for | VRAM |
|---|---|---|---|
| `viet_pair` | PhoGPT-4B + PhoGPT-4B-Chat, int8 | AI detection, Vietnamese | ~7.1 GB |
| `qwen_instruct` | Qwen2.5-1.5B-Instruct, 4-bit | search queries (metadata), rewrite, explain | ~1.2 GB |
| `qwen_base` | Qwen2.5-1.5B, 4-bit | AI detection mode 2 only (Binoculars) | ~1.2 GB |
| `ai_classifier` | ai-text-detector-small | AI detection, English | ~0.6 GB |
| `e5` | multilingual-e5-small | similarity ranking and matching | ~0.5 GB |

The marker DOCX preview is a separate program (`marker_preview.py`); see
below.

## What happens on each card

The budget is the card's memory minus `GPU_RESERVE_GB` (0.8) minus
`GPU_JOB_HEADROOM_GB` (1.0) per GPU job slot (`GPU_JOB_SLOTS`, 2):

| Card | Budget | Behaviour |
|---|---|---|
| 24 GB | ~21 GB | Everything stays loaded, as before. The DOCX preview uses `balanced` mode on the GPU. |
| 12 GB | ~9 GB | A Vietnamese check (`viet_pair` + `qwen_instruct` + `e5`) fits. When an English check needs `ai_classifier` too, the least recently used small model is unloaded and reloaded later (a few seconds). The Vietnamese pair only goes when it has been idle for 10 s and an English check needs the room; reloading it takes roughly 30–60 s. The DOCX preview runs on the CPU in `fast` mode. |

Other rules:

- A model is never unloaded while a job is using it. A job that needs room
  waits for others to finish their step. After `GPU_MODEL_WAIT_SECONDS`
  (300) it loads anyway.
- If CUDA still runs out of memory mid-step, idle models are unloaded and
  the step is retried once.
- `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` is set by `api/app.py`,
  so memory freed by an unload can be reused instead of staying fragmented.

The log shows every load and unload:

```
GPU 11.8 GB: models may use 9.0 GB
Loaded viet_pair: 7.1 GB in 41s
Unloading e5 (0.5 GB) to make room
```

## Settings (`backend/.env`, all optional)

| Key | Default | |
|---|---|---|
| `GPU_MODEL_BUDGET_GB` | computed | Set an exact budget instead |
| `GPU_RESERVE_GB` | `0.8` | CUDA context and allocator slack |
| `GPU_JOB_HEADROOM_GB` | `1.0` | Working memory per running job |
| `GPU_JOB_SLOTS` | `2` | GPU jobs at once. `1` on 12 GB gives the models 1 GB more and means fewer unloads, but jobs queue more |
| `GPU_EVICT_GRACE_SECONDS` | `10` | A model used this recently isn't unloaded |
| `GPU_MODEL_WAIT_SECONDS` | `300` | Longest wait for room before loading anyway |
| `MARKER_GPU_MIN_VRAM_GB` | `20` | Below this, the DOCX preview defaults to `fast` mode on the CPU |
| `MARKER_MODE` / `MARKER_DEVICE` | auto | Override the preview's mode (`balanced`/`fast`) and device (`cpu`/`cuda`) |

## The DOCX preview on 12 GB

Its `balanced` mode starts a vLLM container that keeps several GB reserved
for as long as it runs. A 12 GB card doesn't have that to spare, so below
`MARKER_GPU_MIN_VRAM_GB` the preview uses `fast` mode on the CPU. It's
slower and weaker on equations, but it runs in the background after the
check, so nobody waits on it, and it doesn't take a GPU job slot.

To force `balanced` on 12 GB anyway, set `MARKER_MODE=balanced` and
`MARKER_KEEP_ALIVE=false`. Idle check models are then unloaded before each
conversion and the container stops after it, but every preview pays the
1–2 minute warm-up.

## Checking the real numbers

```bash
watch -n 2 nvidia-smi
grep -E "Loaded|Unloading|out of memory|GPU budget" logs/api.err.log | tail -20
```

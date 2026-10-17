import gpu_models
from config import MODEL_NAME


def _load():
    from sentence_transformers import SentenceTransformer

    return SentenceTransformer(MODEL_NAME)


# Loaded on first use (gpu_models), not at import.
gpu_models.register("e5", _load, estimate_gb=0.5)


def _encode(text):
    with gpu_models.use("e5") as model:
        return gpu_models.retry_on_oom(lambda: model.encode(text, normalize_embeddings=True))


def embed_query(text):
    return _encode("query: " + text)


def embed_passage(text):
    return _encode("passage: " + text)

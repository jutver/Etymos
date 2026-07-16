from sentence_transformers import SentenceTransformer
from config import MODEL_NAME

model = SentenceTransformer(MODEL_NAME)


def embed_query(text):
    text = "query: " + text

    return model.encode(
        text,
        normalize_embeddings=True
    )


def embed_passage(text):
    text = "passage: " + text

    return model.encode(
        text,
        normalize_embeddings=True
    )
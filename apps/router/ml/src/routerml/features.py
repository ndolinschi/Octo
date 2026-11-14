"""Stage 2: routing-time features.

Only `config.ROUTING_FIELDS` can be read. `routing_view` is the single entry point; it drops every other
column, and `text_stats` / `embed` / `TfidfSvd` take the routing view only. tests/test_leak.py checks that
perturbing the forbidden fields leaves the feature matrix unchanged.
`repo` is in the routing view only to group the splits; it is never turned into a feature.
"""

from __future__ import annotations

import json
import re

import numpy as np
import pandas as pd

from . import config as C

ERROR_WORDS = re.compile(
    r"\b(error|exception|traceback|fails?|failed|failing|crash(es|ed)?|bug|wrong|incorrect|unexpected|raises?|segfault|regression|warning|deprecat\w*)\b",
    re.I,
)
FEATURE_WORDS = re.compile(r"\b(add|support|feature|implement|allow|enhancement|new option|would be nice|proposal)\b", re.I)
PATH_RE = re.compile(r"\b[\w./-]+\.(py|pyx|c|h|js|ts|rst|txt|cfg|toml|ini|yml|yaml|json|html)\b")
IDENT_RE = re.compile(r"`[^`\n]{1,80}`|\b[a-z_]+\.[a-z_]+(\.[a-z_]+)*\(|\b[A-Z][a-z]+[A-Z]\w+\b|\b\w+_\w+\b")
URL_RE = re.compile(r"https?://\S+")
TRACE_RE = re.compile(r"Traceback \(most recent call last\)|^\s+File \".*\", line \d+", re.M)
CODE_FENCE = re.compile(r"```")
VERSION_RE = re.compile(r"\b\d+\.\d+(\.\d+)?\b")
REF_DATE = pd.Timestamp("2010-01-01", tz="UTC")

STAT_COLUMNS = [
    "len_chars", "len_words", "n_lines", "n_code_fences", "n_indented_lines", "has_traceback", "n_trace_frames",
    "n_paths", "n_identifiers", "n_urls", "n_error_words", "n_feature_words", "n_version_mentions",
    "frac_code_lines", "n_questions", "created_days",
]


def routing_view(tasks: pd.DataFrame) -> pd.DataFrame:
    """The only columns a feature may be computed from."""
    return tasks.loc[:, list(C.ROUTING_FIELDS)].copy()


def _check(view: pd.DataFrame) -> None:
    bad = set(view.columns) & set(C.FORBIDDEN_FIELDS)
    extra = set(view.columns) - set(C.ROUTING_FIELDS)
    if bad or extra:
        raise ValueError(f"feature input carries non-routing columns: {sorted(bad | extra)}")


def text_stats(view: pd.DataFrame) -> pd.DataFrame:
    _check(view)
    rows = []
    for t in view["problem_statement"].fillna(""):
        lines = t.splitlines() or [""]
        ind = sum(1 for ln in lines if ln.startswith(("    ", "\t", ">>> ")))
        rows.append(
            dict(
                len_chars=len(t),
                len_words=len(t.split()),
                n_lines=len(lines),
                n_code_fences=len(CODE_FENCE.findall(t)) // 2,
                n_indented_lines=ind,
                has_traceback=int("Traceback (most recent call last)" in t),
                n_trace_frames=len(TRACE_RE.findall(t)),
                n_paths=len(PATH_RE.findall(t)),
                n_identifiers=len(IDENT_RE.findall(t)),
                n_urls=len(URL_RE.findall(t)),
                n_error_words=len(ERROR_WORDS.findall(t)),
                n_feature_words=len(FEATURE_WORDS.findall(t)),
                n_version_mentions=len(VERSION_RE.findall(t)),
                frac_code_lines=ind / max(1, len(lines)),
                n_questions=t.count("?"),
            )
        )
    out = pd.DataFrame(rows, index=view.index)
    created = pd.to_datetime(view["created_at"], utc=True)
    out["created_days"] = (created - REF_DATE).dt.days.astype(float)
    return out[STAT_COLUMNS]


class TfidfSvd:
    """TF-IDF + truncated SVD; fit on training-fold texts only."""

    def __init__(self, n_components: int = 32, seed: int = C.SEED):
        from sklearn.decomposition import TruncatedSVD
        from sklearn.feature_extraction.text import TfidfVectorizer

        self.vec = TfidfVectorizer(max_features=20000, min_df=2, sublinear_tf=True, ngram_range=(1, 2))
        self.svd = TruncatedSVD(n_components=n_components, random_state=seed)

    def fit(self, view: pd.DataFrame) -> "TfidfSvd":
        _check(view)
        self.svd.fit(self.vec.fit_transform(view["problem_statement"].fillna("")))
        return self

    def transform(self, view: pd.DataFrame) -> np.ndarray:
        _check(view)
        return self.svd.transform(self.vec.transform(view["problem_statement"].fillna("")))


def embed(view: pd.DataFrame, max_len: int = 256, batch: int = 32) -> np.ndarray:
    """all-MiniLM-L6-v2 (ONNX, CPU), mean pooled and L2-normalised. Head of the text, `max_len` tokens."""
    _check(view)
    import onnxruntime as ort
    from tokenizers import Tokenizer

    d = C.DATA / "minilm"
    tok = Tokenizer.from_file(str(d / "tokenizer.json"))
    tok.enable_truncation(max_length=max_len)
    tok.enable_padding(pad_id=0, pad_token="[PAD]")
    so = ort.SessionOptions()
    so.intra_op_num_threads = 2
    sess = ort.InferenceSession(str(d / "model.onnx"), so, providers=["CPUExecutionProvider"])
    names = {i.name for i in sess.get_inputs()}
    texts = view["problem_statement"].fillna("").tolist()
    out = []
    for i in range(0, len(texts), batch):
        enc = tok.encode_batch(texts[i : i + batch])
        ids = np.array([e.ids for e in enc], dtype=np.int64)
        mask = np.array([e.attention_mask for e in enc], dtype=np.int64)
        feed = {"input_ids": ids, "attention_mask": mask}
        if "token_type_ids" in names:
            feed["token_type_ids"] = np.zeros_like(ids)
        h = sess.run(None, feed)[0]
        m = mask[..., None].astype(np.float32)
        v = (h * m).sum(1) / np.clip(m.sum(1), 1e-9, None)
        out.append(v / np.linalg.norm(v, axis=1, keepdims=True))
    return np.vstack(out)


def main() -> None:
    from .build import load_tasks

    tasks = load_tasks().sort_values("instance_id").reset_index(drop=True)
    view = routing_view(tasks)
    st = text_stats(view)
    st.insert(0, "instance_id", tasks["instance_id"])
    st.to_csv(C.RESULTS / "features_textstats.csv", index=False)
    emb = embed(view)
    np.save(C.DATA / "embeddings_minilm.npy", emb)
    # analysis-only columns, kept apart from the features
    tasks[["instance_id", "repo", "created_at", "difficulty"]].to_csv(C.RESULTS / "analysis_columns.csv", index=False)
    meta = json.loads((C.DATA / "minilm" / "meta.json").read_text())
    meta.update({"dim": int(emb.shape[1]), "max_tokens": 256, "rows": int(emb.shape[0])})
    (C.RESULTS / "embeddings_meta.json").write_text(json.dumps(meta, indent=1))
    print("text stats", st.shape, "embeddings", emb.shape)


if __name__ == "__main__":
    main()

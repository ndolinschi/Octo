"""Stage 6 features: only what the router sees at delegation time (`POST /autoroute/v1/route`'s task: title, brief,
tools, depth). `delegation_view` is the only door from the task table to a feature; a test asserts the list and that
scrambling every leak column changes nothing.

Also here: the router's own deterministic text rule (`apps/router/src/auto/delegate/band.rs::fallback` with the facts of
`jev::inspect`), ported line by line, used as a baseline.
"""

from __future__ import annotations

import hashlib
import re

import numpy as np
import pandas as pd

from . import config as C

FEATURE_FIELDS = ("title", "brief", "tools", "depth")
# Columns of the task table that must never reach a feature (the leak ablation reads them explicitly, by name).
LEAK_FIELDS = (
    "source",
    "task_id",
    "uid",
    "group",
    "created",
    "brief_descriptive",
    "leak_difficulty",
    "leak_constraints",
    "leak_starter",
    "leak_platform",
    "leak_solution",
    "leak_tests",
    "leak_libs",
    "leak_hints",
    "leak_n_public_tests",
)

STAT_COLUMNS = (
    "log_chars",
    "log_words",
    "log_lines",
    "frac_code_lines",
    "n_code_fences",
    "n_backticks",
    "n_paths",
    "n_identifiers",
    "n_digits_frac",
    "n_math",
    "n_questions",
    "n_bullets",
    "n_examples",
    "has_traceback",
    "n_error_words",
    "n_design_words",
    "n_edit_words",
    "n_test_words",
    "title_words",
    "n_tools",
    "depth",
)

PATH_RE = re.compile(r"[\w./-]+\.(?:py|ts|tsx|js|go|rs|java|toml|json|ya?ml|md|txt|c|h|cpp|sh|css|html|sql)\b")
IDENT_RE = re.compile(r"\b[a-z]+(?:_[a-z0-9]+)+\b|\b[a-z]+[A-Z]\w*\b")
MATH_RE = re.compile(r"\$[^$]+\$|\\leq|\\le\b|\\times|10\^")
ERROR_RE = re.compile(r"\b(error|exception|traceback|crash|fail(?:s|ed|ing)?|bug|wrong|incorrect)\b", re.I)
DESIGN_RE = re.compile(r"\b(design|architecture|migrat\w*|concurren\w*|distributed|protocol|refactor\w*|across)\b", re.I)
EDIT_RE = re.compile(r"\b(rename|change|replace|fix|add|remove|delete|update|bump|typo)\b", re.I)
TEST_RE = re.compile(r"\b(tests?|pytest|assert\w*)\b", re.I)
EXAMPLE_RE = re.compile(r"\b(example|sample input)\b", re.I)


def delegation_view(tasks: pd.DataFrame) -> pd.DataFrame:
    """The only columns a feature may be computed from."""
    return tasks.loc[:, list(FEATURE_FIELDS)].copy()


def _check(view: pd.DataFrame) -> None:
    extra = set(view.columns) - set(FEATURE_FIELDS)
    if extra:
        raise ValueError(f"feature input carries non-routing columns: {sorted(extra)}")


def task_text(title: str, brief: str) -> str:
    """As the router builds it (`delegate/run.rs::task_text`)."""
    t, b = (title or "").strip(), (brief or "").strip()
    if not b:
        return t
    if not t:
        return b
    return f"{t}\n\n{b}"


def texts(view: pd.DataFrame) -> list[str]:
    _check(view)
    return [task_text(t, b) for t, b in zip(view.title, view.brief)]


def text_stats(view: pd.DataFrame) -> pd.DataFrame:
    _check(view)
    rows = []
    for title, text, tools, depth in zip(view.title, texts(view), view.tools, view.depth):
        lines = text.splitlines() or [""]
        code = sum(1 for ln in lines if ln.startswith(("    ", "\t", ">>> ")))
        rows.append(
            dict(
                log_chars=np.log1p(len(text)),
                log_words=np.log1p(len(text.split())),
                log_lines=np.log1p(len(lines)),
                frac_code_lines=code / max(1, len(lines)),
                n_code_fences=text.count("```") // 2,
                n_backticks=text.count("`"),
                n_paths=len(PATH_RE.findall(text)),
                n_identifiers=len(IDENT_RE.findall(text)),
                n_digits_frac=sum(c.isdigit() for c in text) / max(1, len(text)),
                n_math=len(MATH_RE.findall(text)),
                n_questions=text.count("?"),
                n_bullets=sum(1 for ln in lines if ln.lstrip().startswith(("- ", "* ", "1."))),
                n_examples=len(EXAMPLE_RE.findall(text)),
                has_traceback=int("Traceback (most recent call last)" in text),
                n_error_words=len(ERROR_RE.findall(text)),
                n_design_words=len(DESIGN_RE.findall(text)),
                n_edit_words=len(EDIT_RE.findall(text)),
                n_test_words=len(TEST_RE.findall(text)),
                title_words=len((title or "").split()),
                n_tools=len(tools) if tools is not None else 0,
                depth=float(depth),
            )
        )
    return pd.DataFrame(rows, index=view.index)[list(STAT_COLUMNS)]


def embed(text_list: list[str], max_len: int = 256, batch: int = 64) -> np.ndarray:
    """all-MiniLM-L6-v2 (pinned), mean pooled, L2-normalised; cached by content hash in data/stage6/."""
    h = hashlib.sha256(("\x00".join(text_list) + f"|{max_len}").encode()).hexdigest()[:16]
    cache = C.S6_DATA / f"emb_{h}.npy"
    if cache.exists():
        return np.load(cache)
    import torch
    from sentence_transformers import SentenceTransformer

    torch.set_num_threads(4)
    m = SentenceTransformer(str(C.S6_DATA / "encoder"), device="cpu")
    m.max_seq_length = max_len
    e = m.encode(text_list, batch_size=batch, normalize_embeddings=True, show_progress_bar=False)
    np.save(cache, e)
    return e


# ------------------------------------------------------------------------------------------------ the router's rule
PATH_EXTENSIONS = (
    ".rs", ".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".toml", ".md", ".json", ".yaml", ".yml", ".txt", ".sql",
    ".sh", ".c", ".h", ".cpp", ".hpp", ".java", ".kt", ".rb", ".css", ".html", ".xml", ".lock", ".cfg", ".ini",
    ".mjs", ".cjs", ".swift", ".php", ".cs", ".scala",
)  # fmt: skip


def _has_word(h: str, n: str) -> bool:
    start = 0
    while True:
        i = h.find(n, start)
        if i < 0:
            return False
        before = i == 0 or not h[i - 1].isalnum()
        j = i + len(n)
        after = j >= len(h) or not h[j].isalnum()
        if before and after:
            return True
        start = i + 1


def _looks_like_path(t: str) -> bool:
    t = t.strip()
    low = t.lower()
    ext = any(low.endswith(e) and len(low) > len(e) for e in PATH_EXTENSIONS)
    return bool(t) and len(t) < 512 and ("/" in t or "\\" in t or ext)


def _path_mentions(text: str) -> int:
    return sum(1 for tok in text.split() if _looks_like_path(tok.strip(".,;:()[]{}\"'")))


def _asks_inspection(text: str) -> bool:
    low = text.lower()
    phrases = ("list file", "list files", "files in", "list dir", "list directory", "read file", "show file",
               "open file", "inspect", "look at", "look in")  # fmt: skip
    intent = any(p in low for p in phrases) or _has_word(low, "ls") or _has_word(low, "tree")
    if not intent:
        return False
    return _path_mentions(text) > 0 or any(w in low for w in ("repo", "codebase", "project", "directory", "folder", "workspace"))


def router_rule_band(text: str) -> int:
    """0 easy / 1 medium / 2 hard, exactly as `band::fallback` with candidates of several tiers."""
    low = text.lower()
    tests = any(_has_word(low, w) for w in ("test", "tests", "pytest", "jest")) or "unit test" in low
    trace = any(p in low for p in ("stack trace", "stacktrace", "traceback", "exception", "at line"))
    multi = any(p in low for p in ("multiple files", "several files", "across files", "both files")) or _path_mentions(text) >= 2
    chars = len(text)
    signals = int(multi) + int(tests) + int(chars > 1500)
    if trace or signals >= 2:
        return 2
    if signals == 0 and chars <= 280 and not _asks_inspection(text):
        return 0
    return 1

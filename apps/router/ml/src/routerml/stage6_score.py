"""Reference scorer for models/m2_delegation.onnx: onnxruntime + tokenizers + numpy only (no torch, no routerml).

    python src/routerml/stage6_score.py "Rename foo to bar in utils.ts" [--title T] [--model PATH]

Prints p_success for the low / mid / high tier (calibrated) and the tier the design's rule picks at tau
(cheapest tier with p >= tau, else high). The text is built as the router builds it: title, blank line, brief.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

HERE = Path(__file__).resolve().parents[2] / "models"
TIERS = ("low", "mid", "high")


class Scorer:
    def __init__(self, model: Path = HERE / "m2_delegation.onnx", tokenizer: Path = HERE / "m2_delegation_tokenizer" / "tokenizer.json", max_len: int = 256):
        so = ort.SessionOptions()
        so.intra_op_num_threads = 1
        so.inter_op_num_threads = 1
        self.sess = ort.InferenceSession(str(model), so, providers=["CPUExecutionProvider"])
        self.tok = Tokenizer.from_file(str(tokenizer))
        self.tok.enable_truncation(max_length=max_len)
        self.tok.no_padding()

    def score(self, text: str) -> np.ndarray:
        e = self.tok.encode(text)
        ids = np.array([e.ids], dtype=np.int64)
        mask = np.array([e.attention_mask], dtype=np.int64)
        return self.sess.run(None, {"input_ids": ids, "attention_mask": mask})[0][0]


def task_text(title: str, brief: str) -> str:
    t, b = title.strip(), brief.strip()
    return t if not b else (b if not t else f"{t}\n\n{b}")


def choose(p: np.ndarray, tau: float) -> str:
    ok = np.where(p >= tau)[0]
    return TIERS[int(ok[0])] if len(ok) else "high"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("brief")
    ap.add_argument("--title", default="")
    ap.add_argument("--tau", type=float, default=0.5)
    ap.add_argument("--model", default=str(HERE / "m2_delegation.onnx"))
    a = ap.parse_args()
    p = Scorer(Path(a.model)).score(task_text(a.title, a.brief))
    print(json.dumps({"p_success": dict(zip(TIERS, np.round(p, 4).tolist())), "tier": choose(p, a.tau), "tau": a.tau}))


if __name__ == "__main__":
    main()

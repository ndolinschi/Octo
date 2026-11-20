"""Stage 6, M2': a small transformer encoder fine-tuned end to end on CPU to read a delegation brief and predict the
three per-tier success probabilities (soft labels, binary cross-entropy).

Encoder: all-MiniLM-L6-v2 (22.7M parameters, pinned in config.py) + mean pooling + a linear head with 3 outputs.
Training (declared before the first run, never tuned on test folds): 3 epochs, batch 16, AdamW lr 4e-5 (head 1e-3),
weight decay 0.01, linear warm-up 10 % then linear decay, max 256 tokens, dropout 0.1, seed config.SEED. 10 % of the
training groups are held out to fit one temperature per tier (calibration); the model is not retrained on them.

Runs: the five pooled folds and the four leave-one-source-out folds of stage6_eval (same fold assignment), then a
final model on all tasks that is exported to ONNX (models/m2_delegation.onnx, int8 dynamic quantisation) with a parity
check against PyTorch on 100 texts and measured CPU latency for one brief.

    python -m routerml.stage6_m2 [--folds pooled,loso] [--final] [--epochs 3]
Out-of-fold predictions -> data/stage6/m2_oof_<split>.npz; summary -> results/stage6_m2.json.
"""

from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path

import numpy as np

from . import config as C
from . import stage6_data as D
from . import stage6_features as F

ENC = C.S6_DATA / "encoder"
MODELS = C.ROOT / "models"
HP = dict(epochs=3, batch=16, lr=4e-5, lr_head=1e-3, wd=0.01, warmup=0.1, max_len=256, dropout=0.1, val_share=0.1)


def _torch():
    import torch

    torch.set_num_threads(4)
    return torch


class Net:
    """Built lazily so that importing this module needs no torch."""

    @staticmethod
    def make(prior: np.ndarray):
        torch = _torch()
        from transformers import AutoModel

        class M(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.enc = AutoModel.from_pretrained(str(ENC))
                self.drop = torch.nn.Dropout(HP["dropout"])
                self.head = torch.nn.Linear(self.enc.config.hidden_size, 3)
                with torch.no_grad():
                    self.head.bias.copy_(torch.tensor(np.log(prior / (1 - prior)), dtype=torch.float32))
                    self.head.weight.mul_(0.1)

            def forward(self, input_ids, attention_mask):
                h = self.enc(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state
                m = attention_mask.unsqueeze(-1).to(h.dtype)
                v = (h * m).sum(1) / m.sum(1).clamp(min=1e-9)
                return self.head(self.drop(v))

        return M()


def _tok():
    from transformers import AutoTokenizer

    return AutoTokenizer.from_pretrained(str(ENC))


def _batches(tok, texts: list[str], idx: np.ndarray, bs: int):
    torch = _torch()
    for i in range(0, len(idx), bs):
        j = idx[i : i + bs]
        enc = tok([texts[k] for k in j], truncation=True, max_length=HP["max_len"], padding=True, return_tensors="pt")
        yield j, enc["input_ids"], enc["attention_mask"], torch


def predict_logits(model, tok, texts: list[str], bs: int = 64) -> np.ndarray:
    torch = _torch()
    model.eval()
    order = np.argsort([len(t) for t in texts])  # length-sorted batches: less padding
    out = np.zeros((len(texts), 3), np.float32)
    with torch.no_grad():
        for j, ids, mask, _ in _batches(tok, texts, order, bs):
            out[j] = model(ids, mask).numpy()
    return out


def fit_temperature(logits: np.ndarray, S: np.ndarray) -> np.ndarray:
    from scipy.optimize import minimize_scalar

    T = np.ones(3)
    for t in range(3):
        y = S[:, t]

        def nll(lt, z=logits[:, t], y=y):
            p = 1 / (1 + np.exp(-z / math.exp(lt)))
            p = np.clip(p, 1e-6, 1 - 1e-6)
            return -np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))

        T[t] = math.exp(minimize_scalar(nll, bounds=(-2, 3), method="bounded").x)
    return T


def train(texts: list[str], S: np.ndarray, groups: np.ndarray, tr: np.ndarray, seed: int = C.SEED, epochs: int | None = None, log=print):
    """Train on tasks `tr` (minus a held-out 10 % of their groups for the temperature). Returns (model, tok, T)."""
    torch = _torch()
    from transformers import get_linear_schedule_with_warmup

    rng = np.random.default_rng(seed)
    torch.manual_seed(seed)
    g = np.unique(groups[tr])
    val_g = set(rng.choice(g, max(1, int(round(HP["val_share"] * len(g)))), replace=False))
    val = np.array([i for i in tr if groups[i] in val_g])
    fit = np.array([i for i in tr if groups[i] not in val_g])
    prior = np.clip(S[fit].mean(0), 0.02, 0.98)
    model = Net.make(prior)
    tok = _tok()
    head = [p for n, p in model.named_parameters() if n.startswith("head")]
    body = [p for n, p in model.named_parameters() if not n.startswith("head")]
    opt = torch.optim.AdamW([{"params": body, "lr": HP["lr"]}, {"params": head, "lr": HP["lr_head"]}], weight_decay=HP["wd"])
    ep = epochs or HP["epochs"]
    steps = ep * math.ceil(len(fit) / HP["batch"])
    sch = get_linear_schedule_with_warmup(opt, int(HP["warmup"] * steps), steps)
    lossf = torch.nn.BCEWithLogitsLoss()
    Sy = torch.tensor(S, dtype=torch.float32)
    t0 = time.time()
    for e in range(ep):
        model.train()
        order = rng.permutation(fit)
        tot = 0.0
        for j, ids, mask, _ in _batches(tok, texts, order, HP["batch"]):
            loss = lossf(model(ids, mask), Sy[j])
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sch.step()
            tot += float(loss) * len(j)
        log(f"    epoch {e + 1}/{ep}: loss {tot / len(fit):.4f} ({time.time() - t0:.0f} s)")
    T = fit_temperature(predict_logits(model, tok, [texts[i] for i in val]), S[val]) if len(val) else np.ones(3)
    return model, tok, T


def sigmoid(z):
    return 1 / (1 + np.exp(-z))


def run_folds(kind: str, epochs: int | None = None) -> dict:
    from .stage6_eval import folds

    b = D.build()
    t = b["tasks"]
    S, _ = D.labels(b, "A")
    texts = F.texts(F.delegation_view(t))
    groups = t.group.to_numpy()
    raw = np.full((len(t), 3), np.nan)
    cal = np.full((len(t), 3), np.nan)
    info = []
    for name, tr, te in folds(t, kind):
        t0 = time.time()
        print(f"  {kind} fold {name}: train {len(tr)}, test {len(te)}", flush=True)
        model, tok, T = train(texts, S, groups, tr, epochs=epochs)
        z = predict_logits(model, tok, [texts[i] for i in te])
        raw[te] = sigmoid(z)
        cal[te] = sigmoid(z / T)
        info.append(dict(fold=str(name), n_train=len(tr), n_test=len(te), temperature=T.round(3).tolist(), seconds=round(time.time() - t0)))
    np.savez(C.S6_DATA / f"m2_oof_{kind}.npz", uid=t.uid.to_numpy(), raw=raw, cal=cal)
    return {"folds": info}


# ------------------------------------------------------------------------------------------------ final + ONNX
def _choose(P: np.ndarray, tau: float = 0.5) -> np.ndarray:
    ok = P >= tau
    return np.where(ok.any(1), ok.argmax(1), 2)


def export_final(epochs: int | None = None, export_only: bool = False) -> dict:
    torch = _torch()
    b = D.build()
    t = b["tasks"]
    S, _ = D.labels(b, "A")
    texts = F.texts(F.delegation_view(t))
    ckpt = C.S6_DATA / "m2_delegation.pt"
    if export_only and ckpt.exists():  # re-export the trained final model without retraining
        z = torch.load(ckpt, weights_only=False)
        model, tok, T = Net.make(np.full(3, 0.5)), _tok(), np.asarray(z["temperature"])
        model.load_state_dict(z["state_dict"])
        old = MODELS / "m2_delegation.json"
        train_s = z.get("train_seconds") or (json.loads(old.read_text())["train_seconds"] if old.exists() else float("nan"))
    else:
        t0 = time.time()
        model, tok, T = train(texts, S, t.group.to_numpy(), np.arange(len(t)), epochs=epochs)
        train_s = time.time() - t0
        torch.save({"state_dict": model.state_dict(), "temperature": T, "train_seconds": train_s}, ckpt)
    model.eval()
    MODELS.mkdir(exist_ok=True)
    tokdir = MODELS / "m2_delegation_tokenizer"
    tok.save_pretrained(str(tokdir))
    for f in tokdir.iterdir():  # keep only what tokenizers needs
        if f.name not in ("tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "vocab.txt"):
            f.unlink()

    class Wrap(torch.nn.Module):
        def __init__(self, m, temp):
            super().__init__()
            self.m = m
            self.register_buffer("temp", torch.tensor(temp, dtype=torch.float32))

        def forward(self, input_ids, attention_mask):
            return torch.sigmoid(self.m(input_ids, attention_mask) / self.temp)

    w = Wrap(model, T).eval()
    fp32 = C.S6_DATA / "m2_delegation_fp32.onnx"
    ex = tok(["rename foo to bar"], return_tensors="pt")
    torch.onnx.export(
        w,
        (ex["input_ids"], ex["attention_mask"]),
        str(fp32),
        input_names=["input_ids", "attention_mask"],
        output_names=["p_success"],
        dynamic_axes={"input_ids": {0: "b", 1: "n"}, "attention_mask": {0: "b", 1: "n"}, "p_success": {0: "b"}},
        opset_version=17,
        dynamo=False,
    )
    from onnxruntime.quantization import QuantType, quantize_dynamic

    q = MODELS / "m2_delegation.onnx"
    # per-channel weights: per-tensor int8 moved probabilities by up to 0.25 on 100 texts (first export, 2026-11-20)
    quantize_dynamic(str(fp32), str(q), weight_type=QuantType.QInt8, per_channel=True, reduce_range=True)
    meta = {
        "encoder": C.S6_ENCODER,
        "encoder_revision": C.S6_ENCODER_REVISION,
        "params": int(sum(p.numel() for p in model.parameters())),
        "hyper_parameters": HP,
        "temperature": T.round(4).tolist(),
        "train_seconds": round(train_s),
        "outputs": "p_success[low, mid, high] (calibrated)",
        "tiers_scheme": "A (0.80 / 3.4375 $/M blended)",
        "onnx_fp32_bytes": fp32.stat().st_size,
        "onnx_int8_bytes": q.stat().st_size,
    }
    (MODELS / "m2_delegation.json").write_text(json.dumps(meta, indent=1))
    meta["parity"] = parity(w, tok, texts, fp32, q)
    return meta


def parity(w, tok, texts: list[str], fp32: Path, q: Path) -> dict:
    """PyTorch against onnxruntime (fp32 and int8) on 100 texts; CPU latency for one brief through the reference
    scorer (tokenisation + session run), 200 runs after 20 warm-up."""
    import onnxruntime as ort

    torch = _torch()
    rng = np.random.default_rng(C.SEED)
    sample = [texts[i] for i in rng.choice(len(texts), 100, replace=False)]
    with torch.no_grad():
        ref = np.vstack([w(**{k: v for k, v in tok([s], truncation=True, max_length=HP["max_len"], return_tensors="pt").items() if k in ("input_ids", "attention_mask")}).numpy() for s in sample])
    from .stage6_score import Scorer

    out = {}
    for name, path in (("fp32", fp32), ("int8", q)):
        sc = Scorer(path, MODELS / "m2_delegation_tokenizer" / "tokenizer.json")
        got = np.vstack([sc.score(s) for s in sample])
        d = np.abs(got - ref)
        out[name] = {
            "max_abs_diff": float(d.max()),
            "mean_abs_diff": float(d.mean()),
            "same_tier_at_tau_0.5": float(np.mean(_choose(got) == _choose(ref))),
            "same_tier_over_tau_0.05_to_0.95": float(np.mean([np.mean(_choose(got, u) == _choose(ref, u)) for u in np.arange(0.05, 0.96, 0.05)])),
        }
        brief = "Rename the variable foo to bar in src/utils.ts. Only that file; keep behaviour the same."
        for _ in range(20):
            sc.score(brief)
        lat = []
        for _ in range(200):
            t0 = time.perf_counter()
            sc.score(brief)
            lat.append((time.perf_counter() - t0) * 1e3)
        long_brief = texts[int(np.argmax([len(x) for x in texts]))]
        lat_long = []
        for _ in range(50):
            t0 = time.perf_counter()
            sc.score(long_brief)
            lat_long.append((time.perf_counter() - t0) * 1e3)
        out[name]["latency_ms_short_brief_p50_p99"] = [round(float(np.percentile(lat, 50)), 2), round(float(np.percentile(lat, 99)), 2)]
        out[name]["latency_ms_256_token_brief_p50_p99"] = [round(float(np.percentile(lat_long, 50)), 2), round(float(np.percentile(lat_long, 99)), 2)]
    _ = ort
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--folds", default="pooled,loso")
    ap.add_argument("--final", action="store_true")
    ap.add_argument("--epochs", type=int, default=None)
    ap.add_argument("--export-only", action="store_true", help="re-export data/stage6/m2_delegation.pt (no training)")
    a = ap.parse_args()
    res_file = C.RESULTS / "stage6_m2.json"
    res = json.loads(res_file.read_text()) if res_file.exists() else {}
    res["hyper_parameters"] = HP
    for kind in [k for k in a.folds.split(",") if k]:
        res[kind] = run_folds(kind, a.epochs)
        res_file.write_text(json.dumps(res, indent=1))
    if a.final:
        res["final"] = export_final(a.epochs, export_only=a.export_only)
        res_file.write_text(json.dumps(res, indent=1))
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()

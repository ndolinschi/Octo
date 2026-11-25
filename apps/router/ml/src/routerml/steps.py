"""Stage 2, part B (step level): TwinRouterBench's 336 SWE-bench steps (40 Verified tasks).

Label: `target_tier` (low / mid / mid_high / high: the cheapest tier that keeps the whole trajectory passing),
collapsed onto scheme A's three tiers by the price of TwinRouterBench's tier models
(deepseek-v3.2 and minimax-m2.7 -> low, gemini-3-flash -> mid, claude-opus-4.6 -> high).
Features available at step time only: step_index, prefix length (messages, characters), tool errors in the prefix
(non-zero return codes), test runs and edits in the prefix, the last command's kind, TF-IDF of the last message
(fitted inside each training fold). `total_steps` is never used (it leaks the trajectory's length).
Protocol: leave-one-TASK-out (40 folds), multinomial logistic regression with a fixed C declared up front.
Baselines: majority tier of the training fold; step_index alone. Intervals: 1000 bootstraps over tasks.
"""

from __future__ import annotations

import json
import re

import numpy as np
from scipy.sparse import hstack, csr_matrix
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import balanced_accuracy_score, log_loss

from . import config as C
from .stage2 import ci, save
from .trajectories import RE_EDIT, RE_TEST, RE_VIEW

QB = C.DATA / "twinrouterbench" / "data" / "static" / "question_bank.jsonl"
COLLAPSE = {"low": 0, "mid": 0, "mid_high": 1, "high": 2}
RE_RC = re.compile(r"<returncode>\s*(-?\d+)\s*</returncode>")
C_LR = 1.0
N_BOOT = 1000


def _cmd(m):
    out = []
    for t in m.get("tool_calls") or []:
        try:
            out.append(json.loads(t["function"]["arguments"]).get("command", ""))
        except Exception:  # noqa: BLE001
            out.append(str(t.get("function", {}).get("arguments", "")))
    return " && ".join(out)


def step_features(messages: list[dict], step_index: int) -> tuple[np.ndarray, str]:
    """Numeric step-time features and the last message's text. Never sees total_steps or the label."""
    prefix = messages[2:]
    tools = [str(m.get("content") or "") for m in prefix if m.get("role") == "tool"]
    cmds = [_cmd(m) for m in prefix if m.get("role") == "assistant"]
    rcs = [int(x) for t in tools for x in RE_RC.findall(t)]
    last = cmds[-1] if cmds else ""
    kind = [bool(RE_VIEW.search(last)), bool(RE_EDIT.search(last)), bool(RE_TEST.search(last))]
    chars = sum(len(str(m.get("content") or "")) for m in messages)
    x = np.array([step_index, np.log1p(step_index), len(messages), np.log1p(chars), sum(r != 0 for r in rcs),
                  sum(bool(RE_TEST.search(c)) for c in cmds), sum(bool(RE_EDIT.search(c)) for c in cmds), *map(float, kind),
                  float(not any(kind) and bool(last))], float)
    lastmsg = str(messages[-1].get("content") or "") + " " + last
    return x, lastmsg


def load():
    rows = [json.loads(l) for l in QB.open()]
    sw = [r for r in rows if r["benchmark"] == "swebench"]
    X, T, y, g = [], [], [], []
    for r in sw:
        x, t = step_features(r["messages"], r["step_index"])
        X.append(x)
        T.append(t)
        y.append(COLLAPSE[r["target_tier"]])
        g.append(r["instance_id"])
    return np.array(X), T, np.array(y), np.array(g), sw


def lotio(X, T, y, g, use, seed=C.SEED):
    P = np.zeros((len(y), 3))
    for task in np.unique(g):
        te, tr = g == task, g != task
        if use == "majority":
            p = np.bincount(y[tr], minlength=3) / tr.sum()
            P[te] = p
            continue
        cols = [0] if use == "step_index" else list(range(X.shape[1]))
        mu, sd = X[tr][:, cols].mean(0), X[tr][:, cols].std(0) + 1e-9
        A, B = (X[tr][:, cols] - mu) / sd, (X[te][:, cols] - mu) / sd
        if use == "all+tfidf":
            tf = TfidfVectorizer(max_features=2000, ngram_range=(1, 2), min_df=2, sublinear_tf=True)
            ta = tf.fit_transform([T[i] for i in np.where(tr)[0]])
            tb = tf.transform([T[i] for i in np.where(te)[0]])
            A, B = hstack([csr_matrix(A), ta]).tocsr(), hstack([csr_matrix(B), tb]).tocsr()
        lr = LogisticRegression(C=C_LR, max_iter=3000, random_state=seed).fit(A, y[tr])
        p = np.zeros((te.sum(), 3))
        p[:, lr.classes_] = lr.predict_proba(B)
        P[te] = p
    return P


def scores(P, y, idx=None):
    if idx is not None:
        P, y = P[idx], y[idx]
    pred = P.argmax(1)
    return {"accuracy": float((pred == y).mean()), "balanced_accuracy": float(balanced_accuracy_score(y, pred)),
            "log_loss": float(log_loss(y, np.clip(P, 1e-6, 1), labels=[0, 1, 2])),
            "under_tier_rate": float((pred < y).mean())}


def main():
    X, T, y, g, sw = load()
    res = {"method": __doc__, "n_steps": int(len(y)), "n_tasks": int(len(np.unique(g))),
           "label_counts_collapsed": {C.TIERS[t]: int((y == t).sum()) for t in range(3)},
           "label_counts_raw": {k: int(sum(r["target_tier"] == k for r in sw)) for k in COLLAPSE},
           "share_steps_whose_task_has_one_label": float(np.mean([len(set(y[g == t])) == 1 for t in g]))}
    preds = {u: lotio(X, T, y, g, u) for u in ("majority", "step_index", "numeric", "all+tfidf")}
    rng = np.random.default_rng(C.SEED + 50)
    tasks = np.unique(g)
    members = {t: np.where(g == t)[0] for t in tasks}
    boots = [np.concatenate([members[t] for t in rng.choice(tasks, len(tasks))]) for _ in range(N_BOOT)]
    out = {}
    for u, P in preds.items():
        out[u] = {"point": scores(P, y)}
        bs = [scores(P, y, b) for b in boots]
        for k in ("accuracy", "balanced_accuracy", "log_loss"):
            out[u][k + "_ci"] = ci([b[k] for b in bs])
        if u != "majority":
            out[u]["log_loss_minus_majority_ci"] = ci([scores(P, y, b)["log_loss"] - scores(preds["majority"], y, b)["log_loss"] for b in boots[:300]])
            out[u]["balanced_acc_minus_step_index_ci"] = ci([scores(P, y, b)["balanced_accuracy"] - scores(preds["step_index"], y, b)["balanced_accuracy"] for b in boots[:300]])
    res["results"] = out
    save("stage2_steps.json", res)
    for u, v in out.items():
        print(u, {k: round(x, 3) for k, x in v["point"].items()})


if __name__ == "__main__":
    main()

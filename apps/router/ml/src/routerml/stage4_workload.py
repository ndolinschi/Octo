"""Stage 4, L2: routing by kind of work - recognise the WORKLOAD from the first request of a session (criterion 3').

Data: TwinRouterBench's static bank (970 steps / 520 trajectories / 5 workloads), pinned checkout in data/twinrouterbench.
Unit of classification: the trajectory (= a session). Its FIRST REQUEST is the bank row with the smallest step_index
of that trajectory (always step 1 here). From that request ONLY these fields are read (first_request()):
  system      the text of the request's system message(s)
  tools       the request's `functions` list (names and count)
  first_user  the text of the first message with role "user"
  n_messages  the number of messages in that request
Never read: later steps, assistant/tool messages' content, step_index beyond picking the first row, total_steps,
target_tier(_id), benchmark / scenario / benchmark_* / pipeline_stage / collector / notes / id / instance_id (the
instance id is used only to group the cross-validation, never as a feature). tests/test_stage4.py mutates every other
field and later rows and asserts the features are unchanged. The bank has no client field (`collector` is the data
author, not a request header), so "client" cannot be tested.
Feature sets (declared up front):
  full     TF-IDF of system + tool-name bag + tool count + shape of first_user + n_messages
  masked   tool-name bag + tool count + shape + n_messages (NO system prompt)
  masked+text  masked + TF-IDF of first_user's words (content, not only shape)
  shape    shape + n_messages only (no system, no tools)
  shape: log chars, log lines, code fences, path-like tokens, file extensions, XML-like tags, URLs, digit share,
  upper-case share, "content is a list of blocks", question marks, lines starting with a speaker label "Name:".
Classifier: multinomial logistic regression (C = 1), standardised numeric features. Protocol: StratifiedGroupKFold(5)
over trajectories, grouped by SOURCE document (mtRAG turns of one conversation, QMSum queries of one meeting, BFCL cases
of one function set share a group), seed fixed; accuracy (1000 trajectory bootstraps), per-workload recall, confusion.
Policy: each step of a trajectory gets the training fold's most frequent gold tier within the PREDICTED workload (the
stage 3 "workload prior", argmax); scored with the benchmark's own v2 metric (stage3_steps.Scorer, which asserts equality
with compute_v2_scores) against: the same prior with the TRUE workload (same folds), always-low, always-high, the
oracle, and stage 3's step model (leave-one-trajectory-out, quoted from stage3_steps.json).
Unseen workload (leave-one-workload-out): the classifier must name one of the four known workloads. Fallback: a
novelty detector fitted on the training workloads only - (a) for "full": the system prompt is not in the training set
(exact match after whitespace normalisation, a lookup miss); (b) for "masked": the distance to the 5th nearest training
trajectory on the standardised masked features exceeds the 99th percentile of the same distance for held-out training
trajectories (inner 5-fold) - a flagged session goes to the SAFE tier (high); the cheaper alternative "flagged -> mid"
is also reported. False-flag rate is measured on held-out trajectories of known workloads.
"""

from __future__ import annotations

import json
import re

import numpy as np
from scipy.sparse import csr_matrix, hstack
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedGroupKFold
from sklearn.neighbors import NearestNeighbors

from . import config as C
from .stage2 import ci, save
from .stage3_steps import QB, TIERS4, WORKLOADS, Scorer, boot_idx, with_ci

FIRST_REQUEST_FIELDS = ("system", "tools", "first_user", "n_messages")
SETS = ("full", "masked", "masked+text", "shape")
RE_PATH = re.compile(r"(?:[\w.-]+/)+[\w.-]+")
RE_EXT = re.compile(r"\b[\w-]+\.(?:py|js|ts|rs|go|java|c|cpp|h|md|txt|json|ya?ml|toml|ics|csv|html|sh|cfg|ini)\b")
RE_TAG = re.compile(r"</?[a-zA-Z_][\w-]*>")
RE_URL = re.compile(r"https?://")
RE_SPK = re.compile(r"^[A-Z][\w ]{0,30}:", re.M)
KNN = 5


def text_of(content) -> str:
    if isinstance(content, list):
        return " ".join(str(b.get("text", "")) if isinstance(b, dict) else str(b) for b in content)
    return str(content or "")


def first_request(traj_rows: list[dict]) -> dict:
    """The only door from a trajectory to the classifier: fields of its first routed request."""
    r = min(traj_rows, key=lambda x: x["step_index"])
    msgs = r["messages"]
    sys_txt = "\n".join(text_of(m.get("content")) for m in msgs if m.get("role") == "system")
    fu = next((m for m in msgs if m.get("role") == "user"), {"content": ""})
    tools = [(f.get("name") or (f.get("function") or {}).get("name") or "") for f in (r.get("functions") or [])]
    return {"system": sys_txt, "tools": tools, "first_user": fu.get("content"), "n_messages": len(msgs)}


def shape(req: dict) -> np.ndarray:
    raw = req["first_user"]
    t = text_of(raw)
    n = max(len(t), 1)
    return np.array([np.log1p(len(t)), np.log1p(t.count("\n")), t.count("```"), np.log1p(len(RE_PATH.findall(t))),
                     np.log1p(len(RE_EXT.findall(t))), np.log1p(len(RE_TAG.findall(t))), np.log1p(len(RE_URL.findall(t))),
                     sum(ch.isdigit() for ch in t) / n, sum(ch.isupper() for ch in t) / n,
                     float(isinstance(raw, list) or str(raw).startswith("[{")), np.log1p(t.count("?")),
                     np.log1p(len(RE_SPK.findall(t))), np.log1p(req["n_messages"])], float)


def tool_num(req: dict) -> np.ndarray:
    k = len(req["tools"])
    return np.array([float(k > 0), np.log1p(k)])


def group_of(bench: str, iid: str) -> str:
    if bench == "mtrag":
        return "mtrag/" + re.sub(r"_turn_\d+$", "", iid)
    if bench == "qmsum":
        return "qmsum/" + iid.split("_")[0]
    if bench == "bfcl":
        m = re.match(r"^(.*)_(\d+)-(\d+)-(\d+)$", iid)
        return "bfcl/" + (f"{m.group(1)}-{m.group(3)}" if m else iid)
    return bench + "/" + iid


def load():
    rows = [json.loads(l) for l in QB.open()]
    trajs: dict = {}
    for i, r in enumerate(rows):
        trajs.setdefault((r["benchmark"], r["instance_id"]), []).append(i)
    keys = sorted(trajs)
    reqs = [first_request([rows[i] for i in trajs[k]]) for k in keys]
    y = np.array([WORKLOADS.index(k[0]) for k in keys])
    groups = np.array([group_of(*k) for k in keys])
    return rows, keys, trajs, reqs, y, groups


class Featurizer:
    """Fitted on training trajectories only (TF-IDF vocabularies, scaling)."""

    def __init__(self, fset):
        self.fset = fset

    def _dense(self, reqs):
        cols = [np.array([shape(q) for q in reqs])]
        if self.fset != "shape":
            cols.append(np.array([tool_num(q) for q in reqs]))
        return np.hstack(cols)

    def fit(self, reqs):
        D = self._dense(reqs)
        self.mu, self.sd = D.mean(0), D.std(0) + 1e-9
        self.tv = {}
        if self.fset != "shape":
            self.tv["tools"] = TfidfVectorizer(analyzer=lambda ts: ts, min_df=1).fit([q["tools"] or ["<none>"] for q in reqs])
        if self.fset == "full":
            self.tv["system"] = TfidfVectorizer(max_features=3000, sublinear_tf=True).fit([q["system"] or "<none>" for q in reqs])
        if self.fset == "masked+text":
            self.tv["text"] = TfidfVectorizer(max_features=3000, sublinear_tf=True, min_df=2).fit([text_of(q["first_user"])[:4000] for q in reqs])
        return self

    def dense_std(self, reqs):
        return (self._dense(reqs) - self.mu) / self.sd

    def transform(self, reqs):
        parts = [csr_matrix(self.dense_std(reqs))]
        if "tools" in self.tv:
            parts.append(self.tv["tools"].transform([q["tools"] or ["<none>"] for q in reqs]))
        if "system" in self.tv:
            parts.append(self.tv["system"].transform([q["system"] or "<none>" for q in reqs]))
        if "text" in self.tv:
            parts.append(self.tv["text"].transform([text_of(q["first_user"])[:4000] for q in reqs]))
        return hstack(parts).tocsr()


def fit_predict(reqs, y, tr, te, fset, n_class):
    f = Featurizer(fset).fit([reqs[i] for i in tr])
    A, B = f.transform([reqs[i] for i in tr]), f.transform([reqs[i] for i in te])
    P = np.zeros((len(te), n_class))
    lr = LogisticRegression(C=1.0, max_iter=5000, random_state=C.SEED).fit(A, y[tr])
    P[:, lr.classes_] = lr.predict_proba(B)
    return P, f


def step_policy(rows, keys, trajs, traj_wl, train_traj_idx):
    """Per step: most frequent gold tier (4-tier ids) of the TRAINING trajectories' steps of the assigned workload."""
    gold = np.array([r["target_tier_id"] for r in rows])
    tab = {}
    for w in range(len(WORKLOADS)):
        st = [i for t in train_traj_idx if WORKLOADS.index(keys[t][0]) == w for i in trajs[keys[t]]]
        tab[w] = int(np.bincount(gold[st], minlength=4).argmax()) if st else None
    return tab


def main():
    rows, keys, trajs, reqs, y, groups = load()
    nT = len(keys)
    gold = np.array([r["target_tier_id"] for r in rows])
    scorer = Scorer(rows)
    boots = boot_idx(scorer.tbench, np.random.default_rng(C.SEED + 600))
    step_traj = np.empty(len(rows), int)
    for t, k in enumerate(keys):
        step_traj[trajs[k]] = t
    res = {"method": __doc__, "n_trajectories": nT, "n_groups": int(len(np.unique(groups))),
           "per_workload_trajectories": {w: int((y == i).sum()) for i, w in enumerate(WORKLOADS)},
           "distinct_system_prompts_per_workload": {w: len({reqs[t]["system"] for t in range(nT) if y[t] == i}) for i, w in enumerate(WORKLOADS)},
           "tool_count_per_workload": {w: sorted({len(reqs[t]["tools"]) for t in range(nT) if y[t] == i})[:10] for i, w in enumerate(WORKLOADS)}}

    def scored(pred_steps):
        s, tab = scorer.score(pred_steps, gold, check=True)
        return {"point": s, "ci": with_ci(tab, scorer.tbench, boots)}

    # fixed and oracle
    res["fixed"] = {f"always_{TIERS4[t]}": scored(np.full(len(rows), t)) for t in (0, 3)}
    res["fixed"]["oracle"] = scored(gold)
    st3 = json.loads((C.RESULTS / "stage3_steps.json").read_text())["tiers_4"]
    res["stage3_quoted"] = {"step_model_loto_combined": st3["loto"]["model_argmax"]["point"]["combined_score_percent"],
                            "workload_prior_loto_combined": st3["loto"]["workload_prior_argmax"]["point"]["combined_score_percent"],
                            "step_model_lowo_combined": st3["lowo"]["model_argmax"]["point"]["combined_score_percent"]}
    # ---- within known workloads
    skf = StratifiedGroupKFold(5, shuffle=True, random_state=C.SEED)
    folds = list(skf.split(np.zeros(nT), y, groups))
    within = {}
    true_pred = np.empty(len(rows), int)
    for tr, te in folds:
        tab = step_policy(rows, keys, trajs, None, tr)
        for t in te:
            true_pred[trajs[keys[t]]] = tab[y[t]]
    within["true_workload_prior"] = scored(true_pred)
    rng = np.random.default_rng(C.SEED + 601)
    for fset in SETS:
        P = np.zeros((nT, len(WORKLOADS)))
        pred_steps = np.empty(len(rows), int)
        for tr, te in folds:
            Pt, _ = fit_predict(reqs, y, tr, te, fset, len(WORKLOADS))
            P[te] = Pt
            tab = step_policy(rows, keys, trajs, None, tr)
            for i, t in enumerate(te):
                pred_steps[trajs[keys[t]]] = tab[int(Pt[i].argmax())]
        yh = P.argmax(1)
        acc = (yh == y).astype(float)
        bs = [acc[rng.integers(0, nT, nT)].mean() for _ in range(1000)]
        conf = np.zeros((5, 5), int)
        np.add.at(conf, (y, yh), 1)
        within[fset] = {"accuracy": {"point": float(acc.mean()), "lo": float(np.percentile(bs, 2.5)), "hi": float(np.percentile(bs, 97.5))},
                        "recall": {w: float(conf[i, i] / conf[i].sum()) for i, w in enumerate(WORKLOADS)},
                        "confusion_rows_true_cols_pred": conf.tolist(),
                        "policy": scored(pred_steps),
                        "steps_with_same_tier_as_true_workload_prior": float((pred_steps == true_pred).mean())}
        print(fset, within[fset]["accuracy"], flush=True)
    res["within_known_workloads"] = within
    # ---- leave one workload out
    lowo = {}
    for fset in ("full", "masked"):
        preds = {"no_fallback": np.empty(len(rows), int), "fallback_high": np.empty(len(rows), int),
                 "fallback_mid": np.empty(len(rows), int)}
        per = {}
        false_flags = []
        for w in range(len(WORKLOADS)):
            tr, te = np.where(y != w)[0], np.where(y == w)[0]
            Pt, f = fit_predict(reqs, y, tr, te, fset, len(WORKLOADS))
            tab = step_policy(rows, keys, trajs, None, tr)
            assigned = Pt.argmax(1)
            if fset == "full":
                known = {" ".join(reqs[i]["system"].split()) for i in tr}
                flag = np.array([" ".join(reqs[i]["system"].split()) not in known for i in te])
                ff = 0.0  # a known system prompt is never flagged on held-out trajectories of a known workload
            else:
                Xtr = f.dense_std([reqs[i] for i in tr])
                inner = StratifiedGroupKFold(5, shuffle=True, random_state=C.SEED).split(np.zeros(len(tr)), y[tr], groups[tr])
                d_in = np.zeros(len(tr))
                for a, b in inner:
                    nn = NearestNeighbors(n_neighbors=KNN).fit(Xtr[a])
                    d_in[b] = nn.kneighbors(Xtr[b])[0][:, -1]
                thr = np.percentile(d_in, 99)
                nn = NearestNeighbors(n_neighbors=KNN).fit(Xtr)
                flag = nn.kneighbors(f.dense_std([reqs[i] for i in te]))[0][:, -1] > thr
                ff = float((d_in > thr).mean())
            false_flags.append(ff)
            for i, t in enumerate(te):
                s = trajs[keys[t]]
                base = tab[int(assigned[i])]
                preds["no_fallback"][s] = base
                preds["fallback_high"][s] = 3 if flag[i] else base
                preds["fallback_mid"][s] = 1 if flag[i] else base
            per[WORKLOADS[w]] = {"assigned_to": {WORKLOADS[k]: int((assigned == k).sum()) for k in range(5) if (assigned == k).any()},
                                 "tier_given_without_fallback": TIERS4[tab[int(np.bincount(assigned).argmax())]],
                                 "share_flagged_as_novel": float(flag.mean()),
                                 "false_flag_rate_on_known_heldout": ff}
        lowo[fset] = {"per_heldout_workload": per,
                      **{k: scored(v) for k, v in preds.items()}}
        print("lowo", fset, flush=True)
    res["leave_one_workload_out"] = lowo
    save("stage4_workload.json", res)
    figure(res)
    print("done")


def figure(res):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, axs = plt.subplots(1, 3, figsize=(16, 4.6))
    for ax, fset in zip(axs[:2], ("full", "masked")):
        cm = np.array(res["within_known_workloads"][fset]["confusion_rows_true_cols_pred"])
        ax.imshow(cm / cm.sum(1, keepdims=True), cmap="Blues", vmin=0, vmax=1)
        for i in range(5):
            for j in range(5):
                ax.text(j, i, cm[i, j], ha="center", va="center", fontsize=8)
        ax.set_xticks(range(5), WORKLOADS, fontsize=7)
        ax.set_yticks(range(5), WORKLOADS, fontsize=7)
        ax.set_title(f"L2 workload from the first request: {fset} (rows true)", fontsize=9)
    W = res["within_known_workloads"]
    L = res["leave_one_workload_out"]
    bars = [("always low", res["fixed"]["always_low"]), ("always high", res["fixed"]["always_high"]),
            ("oracle", res["fixed"]["oracle"]), ("true-workload prior", W["true_workload_prior"]),
            ("classifier full", W["full"]["policy"]), ("classifier masked", W["masked"]["policy"]),
            ("classifier shape", W["shape"]["policy"]), ("LOWO masked, no fallback", L["masked"]["no_fallback"]),
            ("LOWO masked, fallback high", L["masked"]["fallback_high"]), ("LOWO full, fallback high", L["full"]["fallback_high"])]
    v = [b[1]["point"]["combined_score_percent"] for b in bars]
    lo = [b[1]["ci"]["combined_score_percent"]["lo"] for b in bars]
    hi = [b[1]["ci"]["combined_score_percent"]["hi"] for b in bars]
    axs[2].barh(range(len(bars)), v, xerr=[np.array(v) - lo, np.array(hi) - v], color="#4c78a8")
    axs[2].set_yticks(range(len(bars)), [b[0] for b in bars], fontsize=7)
    axs[2].axvline(res["stage3_quoted"]["step_model_loto_combined"], color="#e45756", ls="--", lw=1, label="stage 3 step model (LOTO)")
    axs[2].set_xlabel("TwinRouterBench v2 combined score (%)")
    axs[2].legend(frameon=False, fontsize=7)
    axs[2].invert_yaxis()
    fig.tight_layout()
    fig.savefig(C.FIGURES / "stage4_workload.png", dpi=130)
    plt.close(fig)


if __name__ == "__main__":
    main()

"""Stage 2, part B (trajectories): does the first K steps of a cheap run predict its final failure?

Input: data/trajs/<submission>/<id>.traj.json (fetched by routerml.traj_fetch; 9 low-tier core submissions under
scheme A). Each trajectory is normalised to a list of steps (one model call = one step: its thought text, its
command(s), the observation(s) that followed, and the per-step cost where the format records it).

Early features at step K use ONLY steps[:K] and one bit `ended` (the run stopped at or before step K, which the
router sees when it happens). `early_features(prefix, ended)` never receives the rest of the run; a test
checks that changing anything after step K leaves the features unchanged. The run's cost is not a feature
(in the v1 format only the total is recorded, which would leak the run's length).

Detector: logistic regression, leave-one-repository-out, pooled over the 9 submissions with a per-submission
intercept and per-submission z-scores (training repositories only). Label: the run did NOT resolve.

Early cascade (scheme A tiers): at step K, if the detector fires, stop the cheap run and run the dearer tier
(its soft label and mean cost on the task). Wasted cost = cumulative per-step cost to K where recorded
(mini-swe-agent 2.x), else the run's cost x K / total steps. A run that ended by K costs its full cost.
"""

from __future__ import annotations

import json
import pickle
import re
import sys
import time

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

from . import config as C
from .ceiling import costs, shares
from .evaluate import curve_metrics, fixed_points
from .stage2 import ci, load_matrix, save
from .traj_fetch import TRAJ_DIR, TRAJ_SUBMISSIONS

KS = (5, 10, 20)
CACHE = C.DATA / "traj_steps.pkl"
N_BOOT = 200

RE_BASH = re.compile(r"```(?:bash|sh)?\s*\n(.*?)```", re.S)
RE_RC = re.compile(r"<returncode>\s*(-?\d+)\s*</returncode>")
RE_PY = re.compile(r"[\w./-]+\.py\b")
RE_EDIT = re.compile(r"sed\s+-i|cat\s*<<|cat\s*>|>\s*\S+\.py|python3?\s+-\s*<<|perl\s+-pi|\btee\b|\bpatch\b|apply_patch|str_replace|\bed\s")
RE_VIEW = re.compile(r"^\s*(cat|sed\s+-n|head|tail|nl|less|grep|rg|find|ls)\b")
RE_TEST = re.compile(r"pytest|runtests\.py|unittest|\btox\b|manage\.py\s+test|bin/test")
RE_RUNPY = re.compile(r"python3?\s+\S*\.py")
RE_PASS = re.compile(r"\b\d+ passed\b|\bOK\b(?! \()|Ran \d+ tests?[\s\S]*\nOK")
RE_FAIL = re.compile(r"\b\d+ failed\b|\bFAILED\b|\bERROR\b|errors?=\d+|failures=\d+")
NEG = ("still", "again", "fail", "error", "wrong", "doesn't", "does not", "not work", "hmm", "wait", "actually", "instead", "issue persists")
POS = ("fixed", "works", "success", "passes", "passed", "correct", "resolved", "complete")
SUBMIT = "COMPLETE_TASK_AND_SUBMIT"


# ----------------------------------------------------------------------------------- parsing
def _text(x) -> str:
    if x is None:
        return ""
    if isinstance(x, str):
        return x
    if isinstance(x, list):
        return "\n".join(_text(i.get("text") if isinstance(i, dict) and "text" in i else (i.get("content") if isinstance(i, dict) else i)) for i in x)
    if isinstance(x, dict):
        return _text(x.get("text") or x.get("content"))
    return str(x)


def _commands(msg) -> list[str]:
    ex = msg.get("extra")
    if isinstance(ex, dict) and ex.get("actions"):
        return [str(a.get("command", "")) for a in ex["actions"]]
    tc = msg.get("tool_calls")
    if tc:
        out = []
        for t in tc:
            try:
                out.append(str(json.loads(t["function"]["arguments"]).get("command", "")))
            except Exception:  # noqa: BLE001
                out.append(str(t.get("function", {}).get("arguments", "")))
        return out
    if msg.get("object") == "response":
        out = []
        for it in msg.get("output") or []:
            if isinstance(it, dict) and it.get("type") == "function_call":
                try:
                    out.append(str(json.loads(it["arguments"]).get("command", "")))
                except Exception:  # noqa: BLE001
                    out.append(str(it.get("arguments", "")))
        return out
    m = RE_BASH.search(_text(msg.get("content")))
    return [m.group(1).strip()] if m else []


def _thought(msg) -> str:
    if msg.get("object") == "response":
        return "\n".join(_text(it.get("content")) for it in msg.get("output") or [] if isinstance(it, dict) and it.get("type") == "message")
    t = _text(msg.get("content"))
    r = msg.get("reasoning")
    if isinstance(r, str):
        t = r + "\n" + t
    return RE_BASH.sub("", t)


def parse(traj: dict) -> dict:
    """Normalise one trajectory to steps. Each step: thought, commands, observations (rc, length, flags), cost."""
    msgs = traj["messages"]
    steps = []
    for msg in msgs[2:]:
        role, typ = msg.get("role"), msg.get("type")
        if role == "assistant" or msg.get("object") == "response":
            ex = msg.get("extra")
            cost = ex.get("cost") if isinstance(ex, dict) else None
            steps.append({"thought": _thought(msg)[:3000], "cmds": [c[:1500] for c in _commands(msg)], "cost": cost,
                          "rc": [], "obs_len": 0, "tb": 0, "tpass": 0, "tfail": 0, "nonobs": 0})
        elif (role in ("user", "tool") or typ == "function_call_output") and steps:
            s = steps[-1]
            txt = _text(msg.get("content") if "content" in msg else msg.get("output"))
            m = RE_RC.search(txt)
            if m:
                s["rc"].append(int(m.group(1)))
                s["obs_len"] += len(txt)
                s["tb"] += txt.count("Traceback (most recent call last)")
                s["tpass"] += bool(RE_PASS.search(txt))
                s["tfail"] += bool(RE_FAIL.search(txt))
            else:
                s["nonobs"] += 1  # format error, warning, or the final submission echo
    info = traj.get("info", {})
    ms = info.get("model_stats") or {}
    return {"steps": steps, "exit_status": info.get("exit_status"), "total_cost": ms.get("instance_cost"),
            "api_calls": ms.get("api_calls"), "format": traj.get("trajectory_format")}


def build_cache():
    out = {}
    t0 = time.time()
    for sub in TRAJ_SUBMISSIONS:
        d = TRAJ_DIR / sub
        recs = {}
        for f in sorted(d.glob("*.traj.json")):
            try:
                recs[f.name[: -len(".traj.json")]] = parse(json.loads(f.read_text()))
            except Exception as e:  # noqa: BLE001
                recs[f.name[: -len(".traj.json")]] = {"error": repr(e)[:200]}
        out[sub] = recs
        print(sub, len(recs), round(time.time() - t0), "s", flush=True)
    CACHE.write_bytes(pickle.dumps(out))
    return out


# ----------------------------------------------------------------------------------- features
FEATURE_NAMES = ("ended", "n_steps", "frac_rc_nonzero", "n_format_errors", "frac_repeated_cmd", "n_files_seen",
                 "n_view", "n_edit", "n_test_runs", "last_test_pass", "last_test_fail", "n_runpy", "log_obs_chars",
                 "log_max_obs", "n_tracebacks", "log_thought_chars", "neg_words", "pos_words", "submitted",
                 "steps_since_last_edit", "edit_before_test")


def early_features(prefix: list[dict], ended: bool) -> np.ndarray:
    """Features from the first K steps only (prefix = steps[:K]) and whether the run had ended by then."""
    n = len(prefix)
    cmds = [" && ".join(s["cmds"]) for s in prefix]
    rcs = [r for s in prefix for r in s["rc"]]
    seen, rep = set(), 0
    for c in cmds:
        rep += c in seen
        seen.add(c)
    files = set(f for c in cmds for f in RE_PY.findall(c))
    edit = [bool(RE_EDIT.search(c)) for c in cmds]
    test = [bool(RE_TEST.search(c)) for c in cmds]
    last_test = max((i for i in range(n) if test[i]), default=-1)
    last_edit = max((i for i in range(n) if edit[i]), default=-1)
    th = " ".join(s["thought"].lower() for s in prefix)
    obs = [s["obs_len"] for s in prefix]
    return np.array([
        float(ended), n, (np.mean([r != 0 for r in rcs]) if rcs else 0.0), sum(s["nonobs"] for s in prefix) - (1.0 if ended else 0.0),
        rep / max(n, 1), len(files), sum(bool(RE_VIEW.search(c)) for c in cmds), sum(edit), sum(test),
        float(last_test >= 0 and prefix[last_test]["tpass"] > 0 and prefix[last_test]["tfail"] == 0),
        float(last_test >= 0 and prefix[last_test]["tfail"] > 0), sum(bool(RE_RUNPY.search(c)) for c in cmds),
        np.log1p(sum(obs)), np.log1p(max(obs, default=0)), sum(s["tb"] for s in prefix), np.log1p(len(th)),
        sum(th.count(w) for w in NEG) / max(n, 1), sum(th.count(w) for w in POS) / max(n, 1),
        float(any(SUBMIT in c for c in cmds)), (n - 1 - last_edit) if last_edit >= 0 else n,
        float(last_edit >= 0 and last_test > last_edit),
    ], float)


def features_at(rec: dict, K: int | None) -> np.ndarray:
    steps = rec["steps"]
    if K is None:
        return early_features(steps, True)
    return early_features(steps[:K], len(steps) <= K)


def cost_to(rec: dict, K: int, total_cost: float) -> tuple[float, str]:
    steps = rec["steps"]
    if len(steps) <= K:
        return total_cost, "full"
    pc = [s["cost"] for s in steps[:K]]
    if all(c is not None for c in pc) and all(s["cost"] is not None for s in steps):
        return float(sum(pc)), "per_step"
    return total_cost * K / len(steps), "linear"


# ----------------------------------------------------------------------------------- model
def loro_pooled(X, Y, repos, intercept=True):
    """X: list over submissions of (n_task, f); per-submission z-scores (and intercepts) from training repos only.
    With intercept=False the score ranks runs within a submission only (no model-level signal)."""
    n_sub, n = len(X), X[0].shape[0]
    P = np.full((n_sub, n), np.nan)
    oh = np.eye(n_sub)
    for r in np.unique(repos):
        te, tr = repos == r, repos != r
        Xs, ys, Xt = [], [], []
        for j in range(n_sub):
            mu, sd = X[j][tr].mean(0), X[j][tr].std(0)
            sd = np.where(sd < 1e-9, 1.0, sd)
            w = oh[j:j + 1] if intercept else np.zeros((1, 0))
            Xs.append(np.hstack([(X[j][tr] - mu) / sd, np.repeat(w, tr.sum(), 0)]))
            Xt.append(np.hstack([(X[j][te] - mu) / sd, np.repeat(w, te.sum(), 0)]))
            ys.append(Y[j][tr])
        lr = LogisticRegression(C=0.3, max_iter=3000).fit(np.vstack(Xs), np.concatenate(ys))
        for j in range(n_sub):
            P[j, te] = lr.predict_proba(Xt[j])[:, 1]
    return P


def within_auroc(Y, P, cols=None):
    if cols is not None:
        Y, P = Y[:, cols], P[:, cols]
    return float(np.mean([roc_auc_score(Y[j], P[j]) for j in range(len(Y)) if 0 < Y[j].sum() < Y.shape[1]]))


def early_cascade(P, Rl, Cl, CK, ended, S_hi, K_hi, thetas):
    """(cost sum over tasks averaged over runs, quality, stop rate) per threshold."""
    out = []
    for th in thetas:
        stop = P > th
        q = np.where(stop, S_hi[None, :], Rl).mean()
        c = np.where(stop, np.where(ended, Cl, CK) + K_hi[None, :], Cl).mean(0).sum()
        out.append((c, q, stop.mean()))
    return np.array(out)


def main():
    t0 = time.time()
    if "--rebuild" in sys.argv or not CACHE.exists():
        build_cache()
    cache = pickle.loads(CACHE.read_bytes())
    M = load_matrix()
    ids = M.tasks["instance_id"].tolist()
    repos = M.tasks["repo"].to_numpy()
    tier = M.tier_idx("A_model_terciles")
    sub_idx = {s: i for i, s in enumerate(M.subs.submission)}
    subs = [s for s in TRAJ_SUBMISSIONS if s in sub_idx]
    assert all(tier[sub_idx[s]] == 0 for s in subs), "trajectory submissions must be low tier under scheme A"
    # coverage
    cov = {}
    for s in subs:
        recs = cache[s]
        ok = [i for i in ids if i in recs and "steps" in recs[i] and recs[i]["steps"]]
        st = [len(recs[i]["steps"]) for i in ok]
        calls = M.calls[sub_idx[s]][[ids.index(i) for i in ok]]
        cov[s] = {"tasks_with_trajectory": len(ok), "median_steps": float(np.median(st)),
                  "steps_vs_api_calls_median_abs_diff": float(np.median(np.abs(np.array(st) - calls))),
                  "exit_status": {k: int(v) for k, v in zip(*np.unique([str(recs[i]["exit_status"]) for i in ok], return_counts=True))},
                  "per_step_cost_recorded": bool(all(x["cost"] is not None for x in recs[ok[0]]["steps"]))}
    subs = [s for s in subs if cov[s]["tasks_with_trajectory"] == len(ids)]
    rows = [sub_idx[s] for s in subs]
    Y = np.array([1 - M.R[i] for i in rows])
    Rl = np.array([M.R[i] for i in rows])
    Cl = np.array([M.cost[i] for i in rows])
    res = {"method": __doc__, "submissions": subs, "coverage": cov, "features": FEATURE_NAMES, "K": KS}
    rng = np.random.default_rng(C.SEED + 30)
    ur = np.unique(repos)
    members = {r: np.where(repos == r)[0] for r in ur}
    boots = [np.concatenate([members[r] for r in rng.choice(ur, len(ur))]) for _ in range(N_BOOT)]

    # post-hoc baselines on the same 9 submissions: calls+cost (matrix features) and full trajectory + exit status
    from .cascade import run_features
    Xm = [run_features(M.calls[i], M.cost[i]) for i in rows]
    P_m = loro_pooled(Xm, Y, repos)
    exit_ok = lambda s: np.array([[float(str(cache[s][i]["exit_status"]) == "Submitted")] for i in ids])
    Xfull = [np.hstack([np.array([features_at(cache[s][i], None) for i in ids]), exit_ok(s), Xm[j]]) for j, s in enumerate(subs)]
    P_full = loro_pooled(Xfull, Y, repos)
    prior = np.full_like(Y, np.nan, dtype=float)
    for r in np.unique(repos):
        prior[:, repos == r] = Y[:, repos != r].mean(1, keepdims=True)
    det = {"prior_only": prior, "posthoc_calls_cost": P_m, "posthoc_calls_cost_features_only": loro_pooled(Xm, Y, repos, False),
           "posthoc_full_trajectory_exit_calls_cost": P_full}
    feats = {}
    for K in KS:
        feats[K] = [np.array([features_at(cache[s][i], K) for i in ids]) for s in subs]
        det[f"early_K{K}"] = loro_pooled(feats[K], Y, repos)
        det[f"early_K{K}_features_only"] = loro_pooled(feats[K], Y, repos, False)
        # early text-free + matrix-free check: steps-so-far only
        det[f"early_K{K}_ended_and_steps_only"] = loro_pooled([f[:, :2] for f in feats[K]], Y, repos)
    auc = {}
    for k, P in det.items():
        if k == "prior_only":
            continue
        auc[k] = {"auroc_within_model": within_auroc(Y, P), "interval": ci([within_auroc(Y, P, b) for b in boots]),
                  "per_model": {s: float(roc_auc_score(Y[j], P[j])) for j, s in enumerate(subs)}}
    res["detector_auroc"] = auc
    res["fail_rate"] = float(Y.mean())
    res["share_runs_ended_by_K"] = {K: float(np.mean([[len(cache[s][i]["steps"]) <= K for i in ids] for s in subs])) for K in KS}
    # univariate signs at K=10 (pooled within-model AUROC of each feature alone)
    res["single_feature_auroc_K10"] = {n: within_auroc(Y, np.array([f[:, j] for f in feats[10]])) for j, n in enumerate(FEATURE_NAMES)}

    # early cascade, scheme A tiers; the cheap tier's fixed point is these 9 submissions' mean
    all_rows = np.arange(len(tier))
    S, Kc = shares(M.R, all_rows, tier), costs(M.cost, all_rows, tier)
    S9, K9 = S.copy(), Kc.copy()
    S9[:, 0], K9[:, 0] = Rl.mean(0), Cl.mean(0)
    ch = K9[:, 2].sum()
    casc, curves = {}, {}
    cost_mode = {}
    for hi_name, hi in (("to_high", 2), ("to_mid", 1)):
        cr = {"mixture": curve_metrics(fixed_points(S9, K9), S9, K9)}
        thetas_for = lambda P: np.r_[-1, np.quantile(P, np.linspace(0, 1, 101)), 2]
        perfect = early_cascade(Y.astype(float), Rl, Cl, Cl, np.ones_like(Y, bool), S9[:, hi], K9[:, hi], [0.5])
        cr["perfect_posthoc"] = curve_metrics(np.column_stack([perfect[:, 0] / ch, perfect[:, 1]]), S9, K9)
        items = list(det.items()) + [(f"prior_only_stop_at_K{K}", det["prior_only"]) for K in KS]
        for k, P in items:
            if k.endswith("steps_only"):
                continue
            if k.startswith("early_K") or k.startswith("prior_only_stop"):
                K = int(k.split("K")[-1].split("_")[0])
                CK = np.array([[cost_to(cache[s][i], K, Cl[j, t])[0] for t, i in enumerate(ids)] for j, s in enumerate(subs)])
                ended = np.array([[len(cache[s][i]["steps"]) <= K for i in ids] for s in subs])
                cost_mode[K] = {m: int(v) for m, v in zip(*np.unique([[cost_to(cache[s][i], K, 0.0)[1] for i in ids] for s in subs], return_counts=True))}
            else:
                CK, ended = Cl, np.ones_like(Y, bool)
            pts = early_cascade(P, Rl, Cl, CK, ended, S9[:, hi], K9[:, hi], thetas_for(P))
            norm = np.column_stack([pts[:, 0] / ch, pts[:, 1]])
            m = curve_metrics(norm, S9, K9)
            # random stop at matched rate (same K): stop each run with prob = rate, independent of outcome
            rnd = []
            for q in np.linspace(0, 1, 51):
                rq = q * (S9[:, hi].mean()) + (1 - q) * Rl.mean()
                rc = ((1 - q) * Cl + q * (np.where(ended, Cl, CK) + K9[:, hi][None, :])).mean(0).sum() / ch
                rnd.append((rc, rq))
            mr = curve_metrics(np.array(rnd), S9, K9)
            perf_k = early_cascade(Y.astype(float), Rl, Cl, CK, ended, S9[:, hi], K9[:, hi], [0.5])
            mp = curve_metrics(np.column_stack([perf_k[:, 0] / ch, perf_k[:, 1]]), S9, K9)
            bs = []
            for b in boots:
                ptsb = early_cascade(P[:, b], Rl[:, b], Cl[:, b], CK[:, b], ended[:, b], S9[b, hi], K9[b, hi], thetas_for(P))
                chb = K9[b, 2].sum()
                bs.append(curve_metrics(np.column_stack([ptsb[:, 0] / chb, ptsb[:, 1]]), S9[b], K9[b])["auc_norm"]
                          - curve_metrics(fixed_points(S9[b], K9[b]), S9[b], K9[b])["auc_norm"])
            cr[k] = {"auc": m["auc_norm"], "minus_mixture": m["auc_norm"] - cr["mixture"]["auc_norm"],
                     "minus_mixture_ci": ci(bs), "saved95": m["cost_saved_at_95"], "saved99": m["cost_saved_at_99"],
                     "random_stop_same_K_auc": mr["auc_norm"], "perfect_stop_same_K_auc": mp["auc_norm"],
                     "perfect_stop_same_K_saved95": mp["cost_saved_at_95"]}
            if hi_name == "to_high":
                curves[k] = norm
        casc[hi_name] = cr
    res["early_cascade_scheme_A"] = casc
    res["wasted_cost_mode_counts"] = cost_mode
    # check of the linear wasted-cost rule where per-step cost exists
    chk = []
    for s in subs:
        for i in ids:
            st = cache[s][i]["steps"]
            if len(st) > 10 and all(x["cost"] is not None for x in st):
                tot = sum(x["cost"] for x in st)
                if tot > 0:
                    chk.append((sum(x["cost"] for x in st[:10]) / tot) / (10 / len(st)))
    res["per_step_vs_linear_cost_ratio_K10"] = ci(chk) if chk else None
    res["runtime_s"] = round(time.time() - t0)
    save("stage2_trajectories.json", res)
    figure(res, curves, S9, K9)
    print("done", res["runtime_s"], "s")


def figure(res, curves, S9, K9):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, axs = plt.subplots(1, 2, figsize=(12, 4.8))
    ax = axs[0]
    a = res["detector_auroc"]
    xs = list(KS)
    for key, lab, c in (("early_K{}", "early features (first K steps)", "#0969da"), ("early_K{}_ended_and_steps_only", "only 'ended by K' + steps", "#8250df")):
        m = [a[key.format(k)]["auroc_within_model"] for k in xs]
        lo = [a[key.format(k)]["interval"]["lo"] for k in xs]
        hi = [a[key.format(k)]["interval"]["hi"] for k in xs]
        ax.errorbar(xs, m, yerr=[np.subtract(m, lo), np.subtract(hi, m)], fmt="o-", capsize=3, color=c, label=lab)
    for key, lab, c in (("posthoc_calls_cost", "post-hoc: api_calls + cost", "#bc4c00"), ("posthoc_full_trajectory_exit_calls_cost", "post-hoc: full trajectory + exit + calls + cost", "#1a7f37")):
        ax.axhline(a[key]["auroc_within_model"], color=c, ls="--", label=lab)
    ax.axhline(0.5, color="#6e7781", lw=0.8)
    ax.set_xlabel("K (steps of the cheap run seen)")
    ax.set_ylabel("AUROC for 'run fails' (within model, LORO)")
    ax.set_title("Early failure detector, 9 low-tier submissions")
    ax.legend(frameon=False, fontsize=8)
    ax = axs[1]
    fx = fixed_points(S9, K9)
    for k, c in (("early_K5", "#54aeff"), ("early_K10", "#0969da"), ("early_K20", "#0a3069"), ("posthoc_calls_cost", "#bc4c00")):
        if k in curves:
            ax.plot(curves[k][:, 0], curves[k][:, 1], color=c, label=k.replace("_", " "))
    ax.plot(fx[:, 0], fx[:, 1], "o--", color="#1f2328", label="fixed tiers / mixture")
    ax.set_xlabel("cost relative to always-high")
    ax.set_ylabel("expected share solved")
    ax.set_title("Early cascade low -> high (scheme A)")
    ax.legend(frameon=False, fontsize=8)
    for x in axs:
        x.grid(color="#d0d7de", lw=0.6)
    fig.tight_layout()
    fig.savefig(C.FIGURES / "stage2_trajectories.png", dpi=130)


if __name__ == "__main__":
    main()

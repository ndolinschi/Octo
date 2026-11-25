"""Stage 5: figures from results/loro_headline_preds.npz and results/metrics.json."""

from __future__ import annotations

import json

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

from . import config as C
from .evaluate import curve_points, fixed_points, load, upper_hull, utility_points
from .features import routing_view, text_stats

INK, MUTED, GRID = "#1f2328", "#6e7781", "#d0d7de"
COL = {"m1": "#0969da", "iso": "#8250df", "fixed": "#1f2328", "oracle": "#1a7f37", "heur": "#bc4c00"}


def _style(ax):
    ax.grid(color=GRID, lw=0.6)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)


def main() -> None:
    C.FIGURES.mkdir(exist_ok=True)
    d = np.load(C.RESULTS / "loro_headline_preds.npz")
    S, K, raw, iso, platt = d["S"], d["K"], d["raw"], d["iso"], d["platt"]
    tasks, _, _ = load("A_model_terciles", "core")
    h = text_stats(routing_view(tasks))["len_chars"].to_numpy(float)
    repos = tasks["repo"].to_numpy()

    # 1. cost-quality curve
    fig, ax = plt.subplots(figsize=(7, 5))
    fx = fixed_points(S, K)
    for P, lab, c in ((raw, "M1 (LightGBM, raw)", COL["m1"]), (iso, "M1 + isotonic", COL["iso"])):
        pts = curve_points(P, S, K)
        ax.scatter(pts[:, 0], pts[:, 1], s=6, color=c, alpha=0.35)
        hh = upper_hull(np.vstack([pts, fx[[0, 2]]]))
        ax.plot(hh[:, 0], hh[:, 1], color=c, lw=1.6, label=lab)
    # heuristic (3-tier, quantiles from each LORO training fold)
    hp = []
    for q in np.linspace(0, 1, 41):
        a = np.empty(len(S), int)
        for r in np.unique(repos):
            tr, te = repos != r, repos == r
            c1 = np.quantile(h[tr], q) if q > 0 else -np.inf
            c2 = np.quantile(h[tr], q + (1 - q) / 2)
            a[te] = np.where(h[te] <= c1, 0, np.where(h[te] <= c2, 1, 2))
        rr = np.arange(len(a))
        hp.append((K[rr, a].sum() / K[:, 2].sum(), S[rr, a].mean()))
    hh = upper_hull(np.vstack([np.array(hp), fx[[0, 2]]]))
    ax.plot(hh[:, 0], hh[:, 1], color=COL["heur"], lw=1.2, ls="--", label="Length heuristic (3 tiers)")
    rh = upper_hull(fx)
    ax.plot(rh[:, 0], rh[:, 1], color=MUTED, lw=1.2, ls=":", label="Random tier, matched cost (= per-tier prior)")
    oc = upper_hull(np.vstack([utility_points(S, S, K, K), fx[[0, 2]]]))
    ax.plot(oc[:, 0], oc[:, 1], color=COL["oracle"], lw=1.6, label="Oracle (true soft labels and costs)")
    a = np.array([next((t for t in range(3) if s[t] >= 0.5), 2) for s in S])
    rr = np.arange(len(a))
    ax.scatter([K[rr, a].sum() / K[:, 2].sum()], [S[rr, a].mean()], marker="*", s=120, color=COL["oracle"],
               label="Oracle tier (cheapest with share >= 0.5)", zorder=5)
    for i, t in enumerate(C.TIERS):
        ax.scatter(*fx[i], color=COL["fixed"], s=40, zorder=6)
        ax.annotate(f"always-{t}", fx[i], textcoords="offset points", xytext=(6, -12), fontsize=9, color=INK)
    ax.set_xlabel("Cost relative to always-high (simulated from per-instance cost)")
    ax.set_ylabel("Expected share of tasks solved (soft labels)")
    ax.set_title("Leave-one-repository-out, core slice, tier scheme A (500 tasks)", fontsize=11, color=INK, loc="left")
    _style(ax)
    ax.legend(fontsize=8, frameon=False, loc="lower right")
    fig.tight_layout()
    fig.savefig(C.FIGURES / "cost_quality_loro.png", dpi=150)
    plt.close(fig)

    # 2. reliability diagrams
    fig, axes = plt.subplots(1, 3, figsize=(11, 3.8), sharey=True)
    bins = np.linspace(0, 1, 11)
    for i, (ax, t) in enumerate(zip(axes, C.TIERS)):
        ax.plot([0, 1], [0, 1], color=GRID, lw=1)
        for P, lab, c in ((raw, "raw", COL["m1"]), (iso, "isotonic", COL["iso"]), (platt, "Platt", COL["heur"])):
            p = P[:, i]
            e = np.minimum((p * 10).astype(int), 9)
            xs = [p[e == b].mean() for b in range(10) if (e == b).sum() >= 5]
            ys = [S[e == b, i].mean() for b in range(10) if (e == b).sum() >= 5]
            ax.plot(xs, ys, marker="o", ms=3, color=c, lw=1.3, label=lab)
        ax.set_title(f"tier {t}", fontsize=10, color=INK, loc="left")
        ax.set_xlabel("predicted P(solved)")
        _style(ax)
        ax.set_xlim(0, 1)
        ax.set_ylim(0, 1)
    axes[0].set_ylabel("observed share solved")
    axes[0].legend(fontsize=8, frameon=False)
    fig.suptitle("Reliability (LORO, bins with >= 5 tasks); calibrators fitted inside training folds", fontsize=10, x=0.01, ha="left")
    fig.tight_layout()
    fig.savefig(C.FIGURES / "calibration_loro.png", dpi=150)
    plt.close(fig)

    # 3. per-repository bars
    m = json.loads((C.RESULTS / "metrics.json").read_text())["headline_loro"]["per_repo"]
    names = sorted(m, key=lambda r: -m[r]["n"])
    vals = [m[r]["m1_minus_random_hull"] for r in names]
    fig, ax = plt.subplots(figsize=(8, 4))
    ax.bar(range(len(names)), vals, color=[COL["m1"] if v >= 0 else COL["heur"] for v in vals])
    ax.axhline(0, color=INK, lw=0.8)
    ax.set_xticks(range(len(names)))
    ax.set_xticklabels([f"{r.split('/')[1]}\n(n={m[r]['n']})" for r in names], fontsize=7, rotation=45, ha="right")
    ax.set_ylabel("normalised AUC: M1 minus random-tier hull")
    ax.set_title("Per held-out repository (LORO); positive = M1 better", fontsize=10, color=INK, loc="left")
    _style(ax)
    fig.tight_layout()
    fig.savefig(C.FIGURES / "per_repo_loro.png", dpi=150)
    plt.close(fig)
    print("figures written to", C.FIGURES)


if __name__ == "__main__":
    main()

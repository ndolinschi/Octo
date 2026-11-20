"""Stage 6, part 5: results/stage6_report.txt and figures/stage6_*.png from the stage-6 JSON files."""

from __future__ import annotations

import json

import numpy as np

from . import config as C

SRC = C.S6_SOURCES
SHORT = {"canitedit": "CanItEdit", "bigcodebench": "BigCodeBench", "livecodebench": "LiveCodeBench", "swebench_verified": "SWE-V"}


def _j(name):
    p = C.RESULTS / name
    return json.loads(p.read_text()) if p.exists() else None


def f(v, signed=True):
    if v is None:
        return "n/a"
    s = "+" if signed else ""
    return f"{v[0]:{s}.4f} [{v[1]:{s}.4f}, {v[2]:{s}.4f}]"


def report() -> str:
    lab, ev, m2, pr = _j("stage6_labels.json"), _j("stage6_eval.json"), _j("stage6_m2.json"), _j("stage6_probe.json")
    evB, evE = _j("stage6_eval_B.json"), _j("stage6_eval_equal_tokens.json")
    L = ["STAGE 6 - does a delegation brief's text predict the cheapest sufficient tier across a wide range of tasks?", ""]
    L.append("Protocol and gate declared before any data was fetched: fixtures/stage6_protocol.md (committed first).")
    L.append("")
    L.append("1. LABELS (scheme A; model outcomes only)")
    sm = lab["schemes"]["A"]["summary"]
    L.append(f"{'source':14s} {'tasks':>5s} {'models l/m/h':>13s} {'mean solved l/m/h':>20s} {'cheapest sufficient l/m/h/none':>32s} {'task mean 10/50/90%':>22s}")
    for s in SRC:
        x = sm[s]
        mt = "/".join(str(x["models_per_tier"][t]) for t in C.TIERS)
        ms = "/".join(f"{x['mean_soft_label'][t]:.2f}" for t in C.TIERS)
        cs = "/".join(f"{v:.2f}" for v in x["cheapest_sufficient_share"].values())
        sp = "/".join(f"{v:.2f}" for v in sm["spread_of_task_mean_label"][s])
        L.append(f"{SHORT[s]:14s} {x['tasks']:5d} {mt:>13s} {ms:>20s} {cs:>32s} {sp:>22s}")
    L.append(f"Share of each tier's label variance between sources (eta^2): {sm['pooled']['eta_squared_of_source_per_tier']}")
    L.append(f"Tokens per task assumed for cost: {lab['tokens_per_task']}")
    L.append("")
    L.append("Split-half reliability over models (Spearman-Brown; mean [2.5, 97.5] over 200 splits), scheme A:")
    for s, v in lab["schemes"]["A"]["split_half"].items():
        L.append(f"  {SHORT.get(s, s):14s} " + "  ".join(f"{k}: {('n/a' if v[k] is None else f'{v[k][0]:.2f} [{v[k][1]:.2f},{v[k][2]:.2f}]')}" for k in v))
    L.append("")
    if ev:
        L.append("2. CURVE AREA (cost-quality, normalised; 95 % intervals from 1 000 group bootstraps stratified by source)")
        for kind, title in (("pooled", "(a) pooled 5-fold CV"), ("loso", "(c) leave-one-source-out")):
            a = ev[kind]["all"]
            L.append(f"{title}, all {a['n']} tasks; best non-learned baseline: {a['best_non_learned_baseline']}")
            for k, v in a["area"].items():
                g = a["gain_over_mixture"].get(k)
                L.append(f"  {k:52s} area {f(v, False)}   minus mixture {f(g) if g else '-'}")
        L.append("")
        L.append("(b) WITHIN each source (pooled-CV predictions scored inside one source); gain over that source's mixture:")
        names = [k for k in ev["pooled"]["per_source"]["livecodebench"]["gain_over_mixture"]]
        for k in names:
            L.append(f"  {k}")
            for s in SRC:
                g = ev["pooled"]["per_source"][s]["gain_over_mixture"].get(k)
                if g:
                    L.append(f"      {SHORT[s]:14s} {f(g)}")
        L.append("")
        L.append("(c) per held-out source (leave-one-source-out), gain over that source's mixture:")
        for k in ("M1'", "M2'", "length-only (fitted)", "length rank (unfitted)", "router text rule"):
            row = [f"{SHORT[s]} {f(ev['loso']['per_source'][s]['gain_over_mixture'].get(k))}" for s in SRC if ev["loso"]["per_source"][s]["gain_over_mixture"].get(k)]
            if row:
                L.append(f"  {k:24s} " + "; ".join(row))
        L.append("")
        L.append("Probability quality (pooled CV; AUROC against the majority label, Brier skill against the training prior):")
        for name, d in ev["pooled"]["prob_metrics"].items():
            for s in (*SRC, "all"):
                x = d[s]
                L.append(f"  {name:22s} {SHORT.get(s, s):14s} " + "  ".join(f"{t}: AUROC {x[t]['auroc_vs_majority']} BSS {x[t]['brier_skill_vs_prior']} ECE {x[t]['ece']}" for t in C.TIERS))
        L.append(f"  ECE before calibration (pooled): {ev['pooled'].get('ece_raw')}")
        L.append("Cheapest sufficient tier, accuracy of p >= 0.5 (pooled) vs majority class per source:")
        for name, d in ev["pooled"]["cheapest_sufficient_accuracy"].items():
            L.append(f"  {name:40s} {d}")
        L.append(f"  majority class: {ev['pooled']['cheapest_sufficient_majority_class']}")
        L.append("")
        L.append("3. GATE (declared in advance)")
        for m, g in ev["gate"].items():
            L.append(f"  {m}: LOSO gain over best non-learned ({g['best_non_learned_baseline']}) {f(g['loso_gain_over_best_non_learned'])}; "
                     f"within-source positive in {g['sources_with_positive_gain']} -> {g['verdict'].upper()}")
        L.append("")
        if "leak_ablation" in ev:
            L.append("4. LEAK ABLATION (M1' with one leaky field added as its own feature block; 300 bootstraps)")
            L.append(f"  {'variant':52s} {'pooled gain over mixture':>32s} {'LOSO gain over mixture':>32s}")
            for k, v in ev["leak_ablation"].items():
                L.append(f"  {k:52s} {f(v['pooled']['gain_over_mixture_all']):>32s} {f(v['loso']['gain_over_mixture_all']):>32s}")
            L.append("  within-source gain over mixture (pooled CV) and AUROC of p_low:")
            for k, v in ev["leak_ablation"].items():
                L.append(f"  {k:52s} " + "; ".join(f"{SHORT[s]} {v['pooled']['within_gain_over_mixture'][s][0]:+.4f} (AUROC {v['pooled']['within_auroc_low'][s]})" for s in SRC))
            L.append("")
        for title, e in (("SENSITIVITY: tier scheme B (1 / 5 $/M)", evB), ("SENSITIVITY: equal tokens per task in every source", evE)):
            if e:
                L.append(title)
                for kind in ("pooled", "loso"):
                    a = e[kind]["all"]
                    L.append(f"  {kind}: " + "; ".join(f"{k} {f(a['gain_over_mixture'][k])}" for k in ("M1'", "M2'", "source-id prior", "length-only (fitted)", "length rank (unfitted)") if k in a["gain_over_mixture"]))
                L.append(f"  gate: " + "; ".join(f"{m}: {g['verdict']} ({f(g['loso_gain_over_best_non_learned'])}, {g['sources_with_positive_gain']})" for m, g in e["gate"].items()))
                L.append("")
    if m2:
        L.append("5. M2' (MiniLM-L6 fine-tuned on CPU)")
        L.append(f"  hyper-parameters: {m2['hyper_parameters']}")
        for kind in ("pooled", "loso"):
            if kind in m2:
                L.append(f"  {kind}: " + "; ".join(f"{x['fold']}: {x['seconds']} s, T={x['temperature']}" for x in m2[kind]["folds"]))
        if "final" in m2:
            fi = m2["final"]
            L.append(f"  final: {fi['params']:,} parameters; ONNX fp32 {fi['onnx_fp32_bytes'] / 1e6:.1f} MB, int8 {fi['onnx_int8_bytes'] / 1e6:.1f} MB; train {fi['train_seconds']} s")
            for k, v in fi["parity"].items():
                L.append(f"  parity vs PyTorch on 100 texts, {k}: {v}")
        L.append("")
    if pr:
        L.append("6. PROBE (60 hand-written briefs; a sanity probe, NOT evidence of solved rate)")
        for k, v in pr.items():
            if not isinstance(v, dict) or "scores" in k:
                continue
            L.append(f"  {k}: Spearman(difficulty, band) {v.get('spearman_difficulty_vs_band')}; Spearman(tier, band) {v.get('spearman_tier_vs_band')}; "
                     f"agreement {v['agreement_band_eq_tier']}; mean p_low by band {v.get('mean_p_low_by_band')}")
            L.append(f"      confusion band x tier at tau 0.5: {v['confusion_band_x_tier_at_tau_0.5']}")
            for kk, items in (v.get("worst_misses") or {}).items():
                L.append(f"      {kk}: " + " | ".join(f"{x['id']} {x['p']} {x['brief'][:60]}" for x in items))
        L.append("")
    return "\n".join(L)


def figures() -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    ev = _j("stage6_eval.json")
    if not ev:
        return
    C.FIGURES.mkdir(exist_ok=True)
    names = [k for k in ("M1'", "M2'", "length-only (fitted)", "length rank (unfitted)", "router text rule", "source-id prior") ]
    views = [("pooled", "all", "pooled")] + [("pooled", s, f"within {SHORT[s]}") for s in SRC] + [("loso", "all", "LOSO all")] + [("loso", s, f"LOSO {SHORT[s]}") for s in SRC]
    fig, ax = plt.subplots(figsize=(9, 6))
    y = 0
    ticks = []
    colors = dict(zip(names, ["#1f77b4", "#d62728", "#2ca02c", "#9467bd", "#8c564b", "#7f7f7f"]))
    for kind, s, lbl in views:
        blk = ev[kind]["all"] if s == "all" else ev[kind]["per_source"][s]
        for j, nm in enumerate(names):
            g = blk["gain_over_mixture"].get(nm)
            if not g:
                continue
            yy = y + j * 0.12
            ax.errorbar(g[0], yy, xerr=[[g[0] - g[1]], [g[2] - g[0]]], fmt="o", ms=3, color=colors[nm], label=nm if (kind, s) == ("pooled", "all") else None)
        ticks.append((y + 0.3, lbl))
        y += 1
    ax.axvline(0, color="k", lw=0.8)
    ax.set_yticks([t for t, _ in ticks], [l for _, l in ticks])
    ax.invert_yaxis()
    ax.set_xlabel("curve area minus the fixed-tier mixture (95 % CI)")
    ax.set_title("Stage 6: gain over the fixed-tier mixture, pooled / within source / leave-one-source-out")
    ax.legend(fontsize=7, loc="lower right")
    fig.tight_layout()
    fig.savefig(C.FIGURES / "stage6_gains.png", dpi=130)
    plt.close(fig)
    if "leak_ablation" in ev:
        fig, ax = plt.subplots(figsize=(9, 4.5))
        la = ev["leak_ablation"]
        for i, (k, v) in enumerate(la.items()):
            for off, kind, c in ((-0.15, "pooled", "#1f77b4"), (0.15, "loso", "#d62728")):
                g = v[kind]["gain_over_mixture_all"]
                ax.errorbar(g[0], i + off, xerr=[[g[0] - g[1]], [g[2] - g[0]]], fmt="o", ms=3, color=c, label=kind if i == 0 else None)
        ax.set_yticks(range(len(la)), list(la))
        ax.invert_yaxis()
        ax.axvline(0, color="k", lw=0.8)
        ax.set_xlabel("M1' curve area minus the mixture, all tasks")
        ax.set_title("Stage 6: what each leaky field would add")
        ax.legend(fontsize=8)
        fig.tight_layout()
        fig.savefig(C.FIGURES / "stage6_leaks.png", dpi=130)
        plt.close(fig)
    pr = _j("stage6_probe.json")
    if pr:
        probe = json.loads((C.ROOT / "fixtures" / "stage6_probe.json").read_text())["briefs"]
        band = {x["id"]: x["band"] for x in probe}
        keys = [k for k in ("M1' scores", "M2' scores") if k in pr]
        fig, axs = plt.subplots(1, len(keys), figsize=(4.5 * len(keys), 3.5), squeeze=False)
        for ax, k in zip(axs[0], keys):
            for j, b in enumerate(("easy", "medium", "hard")):
                v = [p[0] for i, p in pr[k].items() if band[i] == b]
                ax.scatter(np.full(len(v), j) + np.random.default_rng(j).uniform(-0.15, 0.15, len(v)), v, s=10)
            ax.set_xticks([0, 1, 2], ["easy", "medium", "hard"])
            ax.set_ylabel("predicted p(low tier solves)")
            ax.set_title(k.replace(" scores", "") + " on the 60 probe briefs")
        fig.tight_layout()
        fig.savefig(C.FIGURES / "stage6_probe.png", dpi=130)
        plt.close(fig)


def main() -> None:
    txt = report()
    (C.RESULTS / "stage6_report.txt").write_text(txt + "\n")
    figures()
    print(txt)


if __name__ == "__main__":
    main()

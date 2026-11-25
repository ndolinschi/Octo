# Stage 6 protocol (declared 2026-11-20, before any stage-6 data was fetched or any model trained)

Question: across tasks that range from one-line edits to hard problems, does the task's text predict the cheapest
sufficient tier, beyond what the identity of the benchmark (source) and the text's length already give?

## Labels

Model outcomes only (never a human difficulty tag). Per source, each model is priced from the pinned LiteLLM table
(blend (3·input + output)/4 $/M) and put into a tier with stage 1's scheme A cut points (0.80 / 3.4375 $/M); scheme B
(1 / 5) is the sensitivity check. Soft label per (task, tier) = mean outcome over the tier's models (pass@1 share where a
source gives several samples). Cheapest sufficient tier = the lowest tier with soft label >= 0.5, else "none".

## Features (what the router sees at delegation time)

`title`, `brief`, `tools`, `depth` only. Stripped from the brief by default: a constraints section (competitive
programming), the starter code block (BigCodeBench). Never features: difficulty tags, algorithm tags, reference
solutions, tests, platform, source id. Each of those is tested as a leak in an ablation, not used in the final model.

## Splits and reporting

Every result: (a) pooled (5-fold grouped CV over all sources), (b) within each source (the pooled out-of-fold
predictions scored inside one source, against that source's own fixed-tier mixture), (c) leave-one-source-out.
Groups: contest (LiveCodeBench), task (BigCodeBench, CanItEdit), repository (SWE-bench Verified).
Intervals: 1 000 bootstrap replicates over groups, stratified by source. Curve area as in stage 1 (upper hull of the
operating points with always-low and always-high, averaged over cost between them).

## Baselines

Always-low / mid / high and their mixture; random; source-id prior (pooled only; it equals the mixture within a
source and is not available for an unseen source); unfitted length rank (2-D grid of shortest-share thresholds);
fitted length-only model; the router's own deterministic text rule (`delegate::band::fallback`, ported); the source's
human difficulty tag where one exists, marked as not available at routing time.

## Gate (fixed now)

The learned text model (M1' or M2') is "supported for delegation routing" only if BOTH hold:

1. Leave-one-source-out, its pooled curve area minus the area of the best non-learned baseline available at routing
   time (the fixed-tier mixture, the unfitted length rank, the router's text rule; the best is chosen on the point
   estimate) has a 95 % bootstrap interval above 0.
2. Its within-source gain over that source's fixed-tier mixture is positive (point estimate) in a strict majority of
   sources.

Otherwise the verdict is "not supported".

## Probe

`stage6_probe.json`: 60 hand-written briefs with a-priori bands, committed before any model scored them. Reported:
Spearman between the model's predicted low-tier success and the band, a confusion table of the model's chosen tier
against the band, the worst misses. A sanity probe only.

"""Stage 6 fetch: every source at its pinned revision into data/stage6/ (idempotent).

Small files are fetched whole with GETs of /resolve/<revision>/<path> (the revision pins every byte). LiveCodeBench's
problem files carry the hidden tests (4.5 GB in all): they are streamed line by line and only the statement fields are
written (`lcb_problems.jsonl`, a few MB); nothing large touches the disk. A manifest with sizes, revisions and licences
is written to data/stage6/manifest.json and copied to results/stage6_sources.json.
"""

from __future__ import annotations

import json
import shutil
import sys
import time
from pathlib import Path

import requests

from . import config as C

HUB = "https://huggingface.co"
D = C.S6_DATA
LCB_KEEP = (
    "question_title",
    "question_content",
    "platform",
    "question_id",
    "contest_id",
    "contest_date",
    "starter_code",
    "difficulty",
    "metadata",
)


def _get(url: str, stream: bool = False, tries: int = 6) -> requests.Response:
    for k in range(tries):
        try:
            r = requests.get(url, timeout=120, stream=stream)
        except requests.RequestException:
            time.sleep(3 * (k + 1))
            continue
        if r.status_code == 200:
            return r
        time.sleep(3 * (k + 1))
    raise RuntimeError(f"GET failed: {url}")


def hf_file(repo: str, rev: str, path: str, dst: Path) -> dict:
    if not dst.exists():
        r = _get(f"{HUB}/datasets/{repo}/resolve/{rev}/{path}")
        dst.write_bytes(r.content)
    return {"repo": f"hf:{repo}", "revision": rev, "path": path, "bytes": dst.stat().st_size}


def hf_licence(repo: str, kind: str = "datasets") -> str | None:
    try:
        d = _get(f"{HUB}/api/{kind}/{repo}").json()
    except RuntimeError:
        return None
    lic = (d.get("cardData") or {}).get("license")
    return ",".join(lic) if isinstance(lic, list) else lic


def fetch_lcb() -> list[dict]:
    out = []
    perf = D / "lcb_performances_generation.json"
    if not perf.exists():
        r = _get(f"{C.LCB_SITE_RAW}/{C.LCB_SITE_COMMIT}/{C.LCB_PERF_FILE}")
        perf.write_bytes(r.content)
    out.append(
        {
            "repo": C.LCB_SITE_RAW.replace("https://raw.githubusercontent.com/", "github:"),
            "revision": C.LCB_SITE_COMMIT,
            "path": C.LCB_PERF_FILE,
            "bytes": perf.stat().st_size,
            "licence": "none stated in the site repository (LiveCodeBench code is MIT)",
        }
    )
    probs = D / "lcb_problems.jsonl"
    streamed = 0
    if not probs.exists():
        tmp = probs.with_suffix(".part")
        with tmp.open("w") as fh:
            for name in C.LCB_HF_FILES:
                r = _get(f"{HUB}/datasets/{C.LCB_HF}/resolve/{C.LCB_HF_REVISION}/{name}", stream=True)
                for line in r.iter_lines(chunk_size=1 << 20):
                    if not line:
                        continue
                    streamed += len(line)
                    row = json.loads(line)
                    keep = {k: row.get(k) for k in LCB_KEEP}
                    keep["n_public_tests"] = len(json.loads(row.get("public_test_cases") or "[]"))
                    keep["source_file"] = name
                    fh.write(json.dumps(keep) + "\n")
                print(f"  streamed {name}", file=sys.stderr)
        tmp.rename(probs)
    out.append(
        {
            "repo": f"hf:{C.LCB_HF}",
            "revision": C.LCB_HF_REVISION,
            "path": ",".join(C.LCB_HF_FILES),
            "bytes_streamed_not_stored": streamed or None,
            "bytes": probs.stat().st_size,
            "licence": hf_licence(C.LCB_HF),
        }
    )
    return out


def fetch_bcb() -> list[dict]:
    a = hf_file(C.BCB_HF, C.BCB_HF_REVISION, C.BCB_HF_FILE, D / "bcb_tasks.parquet")
    a["licence"] = hf_licence(C.BCB_HF)
    b = hf_file(C.BCB_PERF_HF, C.BCB_PERF_REVISION, C.BCB_PERF_FILE, D / "bcb_perf_instruct.parquet")
    b["licence"] = hf_licence(C.BCB_PERF_HF) or "none stated"
    return [a, b]


def fetch_cie() -> list[dict]:
    a = hf_file(C.CIE_HF, C.CIE_HF_REVISION, C.CIE_HF_FILE, D / "cie_tasks.parquet")
    a["licence"] = hf_licence(C.CIE_HF)
    b = hf_file(C.CIE_PRED_HF, C.CIE_PRED_REVISION, C.CIE_PRED_FILE, D / "cie_predictions.jsonl")
    b["licence"] = hf_licence(C.CIE_PRED_HF)
    return [a, b]


def fetch_swe() -> list[dict]:
    a = hf_file(C.HF_DATASET, C.HF_REVISION, C.HF_FILE, D / "swebench_verified.parquet")
    a["licence"] = hf_licence(C.HF_DATASET) or "none stated"
    oc = C.RESULTS / "outcomes_core.csv.gz"
    b = {
        "repo": "this repository (stage 1, from SWE-bench/experiments)",
        "revision": C.EXPERIMENTS_COMMIT,
        "path": "apps/router/ml/results/outcomes_core.csv.gz + results/models.csv",
        "bytes": oc.stat().st_size,
        "licence": "none stated (derived 0/1 table)",
    }
    return [a, b]


def fetch_prices() -> dict:
    lit = D / "litellm_prices.json"
    if not lit.exists():
        lit.write_bytes(_get(C.LITELLM_URL).content)
    return {"repo": "github:BerriAI/litellm", "revision": C.LITELLM_COMMIT, "bytes": lit.stat().st_size, "licence": "MIT"}


def fetch_encoder() -> dict:
    from huggingface_hub import snapshot_download

    d = D / "encoder"
    if not (d / "config.json").exists():
        snapshot_download(
            C.S6_ENCODER,
            revision=C.S6_ENCODER_REVISION,
            local_dir=d,
            allow_patterns=[
                "config.json",
                "model.safetensors",
                "tokenizer.json",
                "tokenizer_config.json",
                "vocab.txt",
                "special_tokens_map.json",
                "modules.json",
                "sentence_bert_config.json",
                "1_Pooling/config.json",
            ],
        )
        shutil.rmtree(d / ".cache", ignore_errors=True)
    size = sum(p.stat().st_size for p in d.rglob("*") if p.is_file())
    return {
        "repo": f"hf:{C.S6_ENCODER}",
        "revision": C.S6_ENCODER_REVISION,
        "bytes": size,
        "licence": hf_licence(C.S6_ENCODER, "models"),
    }


def main() -> None:
    D.mkdir(parents=True, exist_ok=True)
    man = {
        "fetched": time.strftime("%Y-%m-%d"),
        "livecodebench": fetch_lcb(),
        "bigcodebench": fetch_bcb(),
        "canitedit": fetch_cie(),
        "swebench_verified": fetch_swe(),
        "prices": fetch_prices(),
        "encoder": fetch_encoder(),
    }
    (D / "manifest.json").write_text(json.dumps(man, indent=1))
    C.RESULTS.mkdir(exist_ok=True)
    (C.RESULTS / "stage6_sources.json").write_text(json.dumps(man, indent=1))
    print(json.dumps(man, indent=1))


if __name__ == "__main__":
    main()

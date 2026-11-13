"""Stage 5 fetch: the second ("own traffic") benchmarks at pinned revisions into data/ (idempotent, resumable).

Terminal-Bench 2 leaderboard (Hugging Face dataset `harborframework/terminal-bench-2-leaderboard`, Apache-2.0) at
config.TB2_REVISION. The repo is ~120 GB (logs, trajectories); only these small files are read:
  submissions/terminal-bench/2.0/<system>/metadata.yaml          agent and model(s) of the system
  submissions/terminal-bench/2.0/<system>/<job>/result.json       job summary: reward per trial name, exception per trial
  submissions/terminal-bench/2.0/<system>/<job>/<trial>/result.json   per trial: cost_usd, tokens (only for the systems
                                                                  whose model is matched to the Verified core, see xbench)
Directory listings are non-recursive (a recursive listing has >10^6 entries and hits the Hub's rate limit).
Files are fetched with plain GETs of /resolve/<revision>/<path> (the revision pins every byte).

SWE-bench Multilingual: per-instance resolved lists from the SWE-bench/experiments clone already in data/experiments
(the pinned config.EXPERIMENTS_COMMIT), evaluation/multilingual/*; the task list from the HF dataset
SWE-bench/SWE-bench_Multilingual at config.ML_REVISION.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

from . import config as C

TB2_DIR = C.DATA / "tb2"
ROOT_PATH = "submissions/terminal-bench/2.0"
HUB = "https://huggingface.co"


def _get(url: str, tries: int = 8) -> requests.Response | None:
    for k in range(tries):
        try:
            r = requests.get(url, timeout=60)
        except requests.RequestException:
            time.sleep(3 * (k + 1))
            continue
        if r.status_code == 200:
            return r
        if r.status_code == 404:
            return None
        time.sleep(min(90, 5 * 2**k) if r.status_code == 429 else 3)
    raise RuntimeError(f"GET failed: {url}")


def ls(path: str) -> list[dict]:
    out, url = [], f"{HUB}/api/datasets/{C.TB2_REPO}/tree/{C.TB2_REVISION}/{path}"
    while url:
        r = _get(url)
        out += r.json()
        nxt = r.links.get("next", {}).get("url")
        url = nxt
    return out


def get_file(path: str) -> Path | None:
    dst = TB2_DIR / path
    if dst.exists():
        return dst
    r = _get(f"{HUB}/datasets/{C.TB2_REPO}/resolve/{C.TB2_REVISION}/{path}")
    if r is None:
        return None
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(r.content)
    return dst


def fetch_tb2_index() -> dict:
    idx_file = TB2_DIR / "index.json"
    idx = json.loads(idx_file.read_text()) if idx_file.exists() else {}
    systems = [e["path"] for e in ls(ROOT_PATH) if e["type"] == "directory"]
    for s in systems:
        name = s.rsplit("/", 1)[-1]
        if name in idx:
            continue
        entries = ls(s)
        jobs = [e["path"] for e in entries if e["type"] == "directory"]
        get_file(f"{s}/metadata.yaml")
        for j in jobs:
            get_file(f"{j}/result.json")
            get_file(f"{j}/config.json")
        idx[name] = {"jobs": [j.rsplit("/", 1)[-1] for j in jobs]}
        idx_file.parent.mkdir(parents=True, exist_ok=True)
        idx_file.write_text(json.dumps(idx, indent=1))
        print("indexed", name, len(jobs), flush=True)
    return idx


def fetch_tb2_trials(systems: list[str], workers: int = 12) -> None:
    """Per-trial result.json (cost, tokens) for the given systems; trial names come from the job summaries."""
    paths = []
    for s in systems:
        for jr in sorted((TB2_DIR / ROOT_PATH / s).glob("*/result.json")):
            js = json.loads(jr.read_text())
            if "stats" not in js:  # dropped by xbench_data as well
                continue
            ev = js["stats"]["evals"]
            names = set()
            for e in ev.values():
                for lst in (e.get("reward_stats") or {}).get("reward", {}).values():
                    names.update(lst)
                for lst in (e.get("exception_stats") or {}).values():
                    names.update(lst)
            job = jr.parent.name
            paths += [f"{ROOT_PATH}/{s}/{job}/{t}/result.json" for t in sorted(names)]
    todo = [p for p in paths if not (TB2_DIR / p).exists()]
    print(f"trial files: {len(paths)}, to fetch {len(todo)}", flush=True)
    done = 0
    with ThreadPoolExecutor(workers) as ex:
        for _ in ex.map(get_file, todo):
            done += 1
            if done % 500 == 0:
                print("  fetched", done, flush=True)


def fetch_multilingual() -> None:
    from huggingface_hub import hf_hub_download

    out = C.DATA / "multilingual"
    out.mkdir(exist_ok=True)
    tasks = out / "tasks.parquet"
    if not tasks.exists():
        p = hf_hub_download(C.ML_DATASET, C.ML_FILE, repo_type="dataset", revision=C.ML_REVISION)
        tasks.write_bytes(Path(p).read_bytes())
    repo = C.DATA / "experiments"
    names = subprocess.run(["git", "ls-tree", "--name-only", C.EXPERIMENTS_COMMIT, "evaluation/multilingual/"],
                           cwd=repo, check=True, capture_output=True, text=True).stdout.split()
    for path in names:
        d = out / path.rsplit("/", 1)[-1]
        d.mkdir(exist_ok=True)
        for rel in ("metadata.yaml", "results/results.json", "per_instance_details.json"):
            tgt = d / rel.replace("results/", "")
            if tgt.exists():
                continue
            r = subprocess.run(["git", "show", f"{C.EXPERIMENTS_COMMIT}:{path}/{rel}"], cwd=repo, capture_output=True)
            if r.returncode == 0:
                tgt.write_bytes(r.stdout)


def main() -> None:
    what = sys.argv[1:] or ["index", "trials", "multilingual"]
    if "index" in what:
        fetch_tb2_index()
    if "trials" in what:
        from .xbench_data import trial_systems

        from .xbench_data import SCAFFOLD

        ts = trial_systems()  # the single-scaffold target first: it is the headline
        fetch_tb2_trials([s for s in ts if s.startswith(SCAFFOLD + "__")])
        fetch_tb2_trials([s for s in ts if not s.startswith(SCAFFOLD + "__")])
    if "multilingual" in what:
        fetch_multilingual()


if __name__ == "__main__":
    main()

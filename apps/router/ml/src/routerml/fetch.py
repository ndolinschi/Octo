"""Stage 0: fetch raw sources at pinned revisions into data/ (idempotent)."""

from __future__ import annotations

import json
import shutil
import subprocess
import urllib.request
from pathlib import Path

from . import config as C


def _run(cmd: list[str], cwd: Path | None = None) -> str:
    return subprocess.run(cmd, cwd=cwd, check=True, capture_output=True, text=True).stdout


def fetch_tasks() -> Path:
    from huggingface_hub import hf_hub_download

    out = C.DATA / "swebench_verified.parquet"
    if not out.exists():
        p = hf_hub_download(C.HF_DATASET, C.HF_FILE, repo_type="dataset", revision=C.HF_REVISION)
        shutil.copy(p, out)
    return out


def fetch_experiments() -> Path:
    repo = C.DATA / "experiments"
    if not repo.exists():
        _run(["git", "clone", "-q", "--filter=blob:none", "--no-checkout", C.EXPERIMENTS_URL, str(repo)])
    _run(["git", "cat-file", "-e", C.EXPERIMENTS_COMMIT], cwd=repo)
    out = C.DATA / "submissions"
    out.mkdir(exist_ok=True)
    names = _run(
        ["git", "ls-tree", "--name-only", C.EXPERIMENTS_COMMIT, "evaluation/verified/"], cwd=repo
    ).split()
    for path in names:
        name = path.rsplit("/", 1)[-1]
        d = out / name
        d.mkdir(exist_ok=True)
        for rel in ("metadata.yaml", "results/results.json", "per_instance_details.json"):
            target = d / rel.replace("results/", "")
            if target.exists():
                continue
            try:
                blob = subprocess.run(
                    ["git", "show", f"{C.EXPERIMENTS_COMMIT}:{path}/{rel}"],
                    cwd=repo,
                    check=True,
                    capture_output=True,
                ).stdout
            except subprocess.CalledProcessError:
                continue
            target.write_bytes(blob)
    return out


def fetch_prices() -> None:
    lit = C.DATA / "litellm_prices.json"
    if not lit.exists():
        urllib.request.urlretrieve(C.LITELLM_URL, lit)
    orr = C.DATA / "openrouter_models.json"
    if not orr.exists():  # snapshot; the catalogue has no revision, so the first fetch is kept
        urllib.request.urlretrieve(C.OPENROUTER_URL, orr)


def fetch_embedding_model() -> Path:
    from huggingface_hub import HfApi, hf_hub_download

    d = C.DATA / "minilm"
    d.mkdir(exist_ok=True)
    meta = d / "meta.json"
    if not meta.exists():
        info = HfApi().model_info(C.EMB_REPO, revision=C.EMB_REVISION, files_metadata=True)
        files = {"onnx/model.onnx", "tokenizer.json"}
        for f in files:
            p = hf_hub_download(C.EMB_REPO, f, revision=info.sha)
            shutil.copy(p, d / Path(f).name)
        sizes = {s.rfilename: s.size for s in info.siblings if s.rfilename in files}
        lic = info.card_data.get("license") if info.card_data else None
        meta.write_text(json.dumps({"repo": C.EMB_REPO, "sha": info.sha, "license": lic, "sizes": sizes}))
    return d


def main() -> None:
    C.DATA.mkdir(exist_ok=True)
    print("tasks:", fetch_tasks())
    print("submissions:", fetch_experiments())
    fetch_prices()
    print("prices: ok")
    print("embedding model:", fetch_embedding_model())


if __name__ == "__main__":
    main()

"""Stage 2 (B, trajectories): download mini-SWE-agent trajectories of low-tier core submissions.

Source: the public S3 bucket named in each submission's metadata.yaml (`assets.trajs`), read anonymously over
HTTPS (https://swe-bench-submissions.s3.amazonaws.com/bash-only/<submission>/trajs/<id>/<id>.traj.json).
Only `<id>.traj.json` files are fetched (no logs, no patches). Raw files go to data/trajs/ (git-ignored).
The S3 objects have no revision; the listing's ETag and LastModified of every file are kept in
data/trajs/<submission>/_manifest.json so a rerun can tell whether the bucket changed.
"""

from __future__ import annotations

import json
import re
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from . import config as C

BUCKET = "https://swe-bench-submissions.s3.amazonaws.com"
# Low tier under scheme A; the subset that fits in ~1.6 GB (Llama-4-Maverick: 3.6 GB, minimax-m2 and
# deepseek-v3.2-reasoner: skipped for size). Declared before any trajectory was read.
TRAJ_SUBMISSIONS = (
    "20250807_mini-v1.7.0_gpt-5-mini",
    "20250807_mini-v1.7.0_gpt-5-nano",
    "20250802_mini-v1.0.0_qwen3-coder-480b-a35b-instruct",
    "20250803_mini-v1.0.0_qwen2-5-coder-32b-instruct",
    "20250807_mini-v1.7.0_gpt-oss-120b",
    "20251209_mini-v1.17.2_devstral-small-2512",
    "20260217_mini-v2.0.0_gpt-5-mini",
    "20260217_mini-v2.0.0_minimax-2-5-high",
    "20260217_mini-v2.0.0_deepseek-3-2-high",
)
TRAJ_DIR = C.DATA / "trajs"


def _list(sub: str) -> list[dict]:
    out, tok = [], None
    while True:
        q = {"list-type": "2", "prefix": f"bash-only/{sub}/trajs/"}
        if tok:
            q["continuation-token"] = tok
        x = urllib.request.urlopen(f"{BUCKET}/?{urllib.parse.urlencode(q)}", timeout=60).read().decode()
        for c in re.findall(r"<Contents>(.*?)</Contents>", x, re.S):
            key = re.search(r"<Key>(.*?)</Key>", c).group(1)
            out.append({"key": key, "size": int(re.search(r"<Size>(\d+)</Size>", c).group(1)),
                        "etag": re.search(r"<ETag>(.*?)</ETag>", c).group(1).replace("&quot;", ""),
                        "modified": re.search(r"<LastModified>(.*?)</LastModified>", c).group(1)})
        m = re.search(r"<NextContinuationToken>(.*?)</NextContinuationToken>", x)
        if not m:
            return out
        tok = m.group(1)


def _get(item, dest):
    if dest.exists() and dest.stat().st_size == item["size"]:
        return 0
    for attempt in range(4):
        try:
            data = urllib.request.urlopen(f"{BUCKET}/{urllib.parse.quote(item['key'])}", timeout=120).read()
            dest.write_bytes(data)
            return len(data)
        except Exception:  # noqa: BLE001 - network retry
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(item["key"])


def main(subs=TRAJ_SUBMISSIONS) -> None:
    for sub in subs:
        d = TRAJ_DIR / sub
        d.mkdir(parents=True, exist_ok=True)
        items = [i for i in _list(sub) if re.fullmatch(rf"bash-only/{re.escape(sub)}/trajs/([^/]+)/\1\.traj\.json", i["key"])]
        (d / "_manifest.json").write_text(json.dumps({"bucket": BUCKET, "listed": time.strftime("%Y-%m-%d"), "files": items}, indent=0))
        t0 = time.time()
        with ThreadPoolExecutor(8) as ex:
            n = sum(ex.map(lambda i: _get(i, d / i["key"].rsplit("/", 1)[1]), items))
        print(sub, len(items), "files", round(n / 1e6, 1), "MB new", round(time.time() - t0), "s", flush=True)


if __name__ == "__main__":
    main(tuple(sys.argv[1:]) or TRAJ_SUBMISSIONS)

"""Stage 4: fit the final M1 (joint, all features, scheme A, core) on all tasks and export it to ONNX.

Only the LightGBM part is exported. Featurisation (text statistics, TF-IDF+SVD, MiniLM + PCA) stays in
Python here; serving it in the router needs those steps ported too (not done).
Check: onnxruntime reproduces LightGBM's probabilities on 100 rows; the max abs difference is printed
and stored in results/onnx_check.json.
"""

from __future__ import annotations

import json

import numpy as np
import onnxruntime as ort
from onnxmltools import convert_lightgbm
from onnxmltools.convert.common.data_types import FloatTensorType

from . import config as C
from .evaluate import M1, FoldFeatures, load
from .features import routing_view, text_stats


def main() -> None:
    tasks, S, K = load("A_model_terciles", "core")
    view = routing_view(tasks)
    emb = np.load(C.DATA / "embeddings_minilm.npy")
    ff = FoldFeatures(view, text_stats(view), emb, "stats+tfidf+emb")
    idx = np.arange(len(tasks))
    m = M1("joint").fit(ff, idx, S, tasks["repo"].to_numpy())
    clf = m.models[0]
    X = ff.transform(idx)
    rows = np.vstack([np.hstack([X, np.full((len(X), 1), t)]) for t in range(3)]).astype(np.float32)
    n_feat = rows.shape[1]
    onx = convert_lightgbm(clf, initial_types=[("input", FloatTensorType([None, n_feat]))], zipmap=False,
                           target_opset=15)
    out_dir = C.ROOT / "models"
    out_dir.mkdir(exist_ok=True)
    path = out_dir / "m1_joint.onnx"
    path.write_bytes(onx.SerializeToString())
    clf.booster_.save_model(str(out_dir / "m1_joint_lgbm.txt"))
    sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    rng = np.random.default_rng(C.SEED)
    sample = rows[rng.choice(len(rows), 100, replace=False)]
    p_ort = sess.run(None, {"input": sample})[1][:, 1]
    p_lgb = clf.predict_proba(sample)[:, 1]
    diff = float(np.abs(p_ort - p_lgb).max())
    res = {"rows_checked": 100, "max_abs_diff": diff, "n_features": n_feat, "params": m.params,
           "onnx_bytes": path.stat().st_size, "feature_names": ff.names() + ["tier_id"]}
    (C.RESULTS / "onnx_check.json").write_text(json.dumps(res, indent=1))
    print("onnx:", path, path.stat().st_size, "bytes; max abs diff on 100 rows:", diff)


if __name__ == "__main__":
    main()

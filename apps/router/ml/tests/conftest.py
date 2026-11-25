"""Shared test helpers. Tests that read downloaded or built data skip, naming what produces it, when it is absent.

`data/` is git-ignored: a fresh clone has none until `make fetch` (and `make build features`) have run.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from routerml import config as C


def _missing(paths: tuple, target: str | None, hint: str | None) -> str | None:
    gone = [str(p) for p in paths if not (p if isinstance(p, Path) else C.DATA / p).exists()]
    if not gone:
        return None
    how = hint or f"run `make {target}` in apps/router/ml"
    return f"needs downloaded data that is missing ({', '.join(gone)}): {how}"


def requires_data(*paths, target: str | None = None, hint: str | None = None):
    """Marker: skip the test when a file is missing. Names are relative to data/ (or absolute Paths)."""
    reason = _missing(paths, target, hint)
    return pytest.mark.skipif(reason is not None, reason=reason or "")


def require_data(*paths, target: str | None = None, hint: str | None = None) -> None:
    """The same inside a fixture or a test body."""
    reason = _missing(paths, target, hint)
    if reason:
        pytest.skip(reason)

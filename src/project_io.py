"""Shared paths, validation and crash-safe output for the data pipeline."""
import json
import math
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)

@contextmanager
def atomic_text(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            yield stream
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

def write_json(path, value):
    with atomic_text(path) as stream:
        json.dump(value, stream, ensure_ascii=False, allow_nan=False, separators=(",", ":"))

def validate_levels(levels):
    for name in ("L0", "L1", "L2"):
        lv = levels[name]
        n, rows = lv["n"], lv["rows"]
        if not isinstance(n, int) or n < 2 or len(rows) != n:
            raise ValueError(f"{name}: invalid grid dimensions")
        if not finite(lv["step"]) or lv["step"] <= 0 or not finite(lv["half"]) or lv["half"] <= 0:
            raise ValueError(f"{name}: invalid grid extent")
        if abs((n - 1) * lv["step"] - 2 * lv["half"]) > 1e-6:
            raise ValueError(f"{name}: inconsistent grid extent")
        if any(len(row) != n or not all(finite(v) for v in row) for row in rows):
            raise ValueError(f"{name}: invalid elevations")

def validate_assets(items, fields):
    if not items or len({t["id"] for t in items}) != len(items):
        raise ValueError("Assets must be nonempty with unique IDs")
    for item in items:
        if not item["id"] or any(not finite(item.get(k)) for k in fields):
            raise ValueError(f"Invalid asset: {item.get('id')}")

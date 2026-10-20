"""jlawcite の検索DBから法令名の辞書を data/law_names.json.gz に書き出す（引用の解釈・検証用）。

形式: {"meta": {...}, "names": [[名前, law_id, 種類]]}
種類: canonical（正式名）・abbrev（略称）・alias（別称）・old_name（旧題名）・promulgation（法令番号、算用数字 例「平成5年法律第88号」）

使い方:
    python scripts/export_names.py --db <jp_search.sqlite> --out data/law_names.json.gz
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import sqlite3
import sys
from pathlib import Path


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", type=Path, required=True)
    ap.add_argument("--out", type=Path, default=Path("data/law_names.json.gz"))
    ap.add_argument("--snapshot", default="2026-09-27")
    a = ap.parse_args()
    con = sqlite3.connect(f"file:{a.db.as_posix()}?mode=ro", uri=True)
    rows = con.execute("SELECT name, law_id, kind FROM law_names ORDER BY kind, name").fetchall()
    counts: dict[str, int] = {}
    for _, _, k in rows:
        counts[k] = counts.get(k, 0) + 1
    blob = {"meta": {"source": "e-Gov 法令検索（デジタル庁）を JLaw-CiteGraph（jlawcite）で加工", "license": "CC BY 4.0（データ）",
                     "egov_snapshot": a.snapshot, "generated": dt.date.today().isoformat(), "counts": counts},
            "names": [list(r) for r in rows]}
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_bytes(gzip.compress(json.dumps(blob, ensure_ascii=False, separators=(",", ":")).encode(), 9))
    print(counts, f"→ {a.out} {a.out.stat().st_size / 1024:.0f}KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())

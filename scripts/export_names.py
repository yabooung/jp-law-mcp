"""jlawcite の検索DBから法令名の辞書を data/law_names.json.gz に書き出す（引用の解釈・検証用）。

形式: {"meta": {...}, "names": [[名前, law_id, 種類]]}（new_name だけ 4 つ目に施行日 YYYY-MM-DD）
種類: canonical（正式名）・abbrev（略称）・alias（別称）・old_name（旧題名）・promulgation（法令番号、算用数字 例「平成5年法律第88号」）
      new_name（施行予定の改正で変わる題名。jlawcite の pending_versions.csv で、施行予定の版の題名が今の題名と違うもの）

使い方:
    python scripts/export_names.py --db <jp_search.sqlite> --jlawcite 2.5.0 --snapshot <日付> --out data/law_names.json.gz
"""
from __future__ import annotations

import argparse
import csv
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
    ap.add_argument("--jlawcite", required=True, help="検索DBを作った jlawcite の版（例 2.5.0）")
    ap.add_argument("--snapshot", required=True, help="e-Gov スナップショット日（jlawcite release_stats.json の egov_snapshot）")
    ap.add_argument("--pending", type=Path, help="施行予定の改正（jlawcite の pending_versions.csv。省略時は検索DBの隣）")
    a = ap.parse_args()
    con = sqlite3.connect(f"file:{a.db.as_posix()}?mode=ro", uri=True)
    rows = [list(r) for r in con.execute("SELECT name, law_id, kind FROM law_names ORDER BY kind, name")]
    titles = dict(con.execute("SELECT law_id, title FROM laws"))
    pending = a.pending or a.db.with_name("pending_versions.csv")
    if not pending.exists():
        raise SystemExit(f"{pending} がない（jlawcite download が検索DBの隣に置く）")
    have = {(n, lid) for n, lid, _ in rows}
    renamed: dict[tuple[str, str], str] = {}
    with pending.open(encoding="utf-8") as f:
        for p in csv.DictReader(f):
            lid, new, d = p["law_id"], p["law_title"], p["enforcement_date"]
            if lid in titles and new and new != titles[lid] and (new, lid) not in have and len(d) == 8:
                day = f"{d[:4]}-{d[4:6]}-{d[6:]}"
                renamed[(new, lid)] = min(renamed.get((new, lid), day), day)
    rows += [[n, lid, "new_name", day] for (n, lid), day in sorted(renamed.items())]
    counts: dict[str, int] = {}
    for k in (r[2] for r in rows):
        counts[k] = counts.get(k, 0) + 1
    blob = {"meta": {"source": f"e-Gov 法令検索（デジタル庁）を JLaw-CiteGraph（jlawcite {a.jlawcite}）で加工", "license": "CC BY 4.0（データ）",
                     "egov_snapshot": a.snapshot, "jlawcite": a.jlawcite, "generated": dt.date.today().isoformat(), "counts": counts},
            "names": rows}
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_bytes(gzip.compress(json.dumps(blob, ensure_ascii=False, separators=(",", ":")).encode(), 9))
    print(counts, f"→ {a.out} {a.out.stat().st_size / 1024:.0f}KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())

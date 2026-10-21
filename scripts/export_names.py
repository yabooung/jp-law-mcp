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


# 税務の実務・国税庁の資料で使う略称（「措法第37条の5」）。jlawcite の辞書にないので、ここで別称（alias）として足す。
# 「法令」「法規」（法人税法施行令・施行規則）は一般の語と重なる（「関係法令第…」）ので入れない
EXTRA_ALIASES = {
    "措法": "租税特別措置法", "措令": "租税特別措置法施行令", "措規": "租税特別措置法施行規則",
    "所法": "所得税法", "所令": "所得税法施行令", "所規": "所得税法施行規則",
    "法法": "法人税法",
    "消法": "消費税法", "消令": "消費税法施行令", "消規": "消費税法施行規則",
    "相法": "相続税法", "相令": "相続税法施行令", "相規": "相続税法施行規則",
    "通法": "国税通則法", "通令": "国税通則法施行令",
    "徴法": "国税徴収法", "徴令": "国税徴収法施行令",
    "地法": "地方税法", "地令": "地方税法施行令",
    "耐用年数省令": "減価償却資産の耐用年数等に関する省令",
}


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
    by_title = {t: lid for lid, t in titles.items()}
    have_names = {r[0] for r in rows}
    rows += [[abbr, by_title[t], "alias"] for abbr, t in EXTRA_ALIASES.items() if t in by_title and abbr not in have_names]
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

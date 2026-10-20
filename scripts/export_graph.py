"""jlawcite の検索DB（jp_search.sqlite）から、条単位の引用・委任グラフを data/graph.json.gz に書き出す。

- 対象: 本則の条から出る CITES（引用）と DELEGATES_TO（委任）。附則から出るものは入れない（経過規定が多く件数が大きい）
- 項・号の参照は条にまとめ、同じ条の中の参照（前項など）は捨てる。数は同じ組の参照回数
- 条が特定できない参照（「同法」「政令で定める」の委任先など）は 条→法令 として別に持つ

形式（キーは短く）:
    meta  : 出典・時点・件数
    laws  : [law_id, 題名]
    arts  : [laws の番号, 条のパス（例 "a57-2"）]
    e     : [引用元 arts 番号, 引用先 arts 番号, 0=CITES / 1=DELEGATES_TO, 回数]
    l     : [引用元 arts 番号, 引用先 laws 番号, 0/1, 回数]

使い方:
    python scripts/export_graph.py --db <jp_search.sqlite> --jlawcite 2.5.0 --out data/graph.json.gz
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import gzip
import json
import re
import sqlite3
import sys
from pathlib import Path

ART = re.compile(r"^(.*?_a(?:sup-[^-]+-)?[0-9][0-9-]*?)(?:_p\d+.*)?$")
REL = {"CITES": 0, "DELEGATES_TO": 1}


def article_of(node_id: str) -> str | None:
    if "_at-" in node_id:
        return None
    m = ART.match(node_id)
    return m.group(1) if m and "_a" in node_id else None


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", type=Path, required=True)
    ap.add_argument("--out", type=Path, default=Path("data/graph.json.gz"))
    ap.add_argument("--jlawcite", required=True, help="検索DBを作った jlawcite の版（例 2.5.0）")
    ap.add_argument("--snapshot", default="2026-09-27", help="e-Gov スナップショット日（jlawcite release_stats.json の egov_snapshot）")
    a = ap.parse_args()

    con = sqlite3.connect(f"file:{a.db.as_posix()}?mode=ro", uri=True)
    titles = dict(con.execute("SELECT law_id, title FROM laws"))
    pairs: collections.Counter = collections.Counter()
    to_law: collections.Counter = collections.Counter()
    skipped: collections.Counter = collections.Counter()
    for src, dst, rel in con.execute("SELECT source, target, rel FROM edges WHERE rel IN ('CITES','DELEGATES_TO')"):
        sa = article_of(src)
        if sa is None:
            skipped["source_not_article"] += 1
            continue
        if "_asup" in sa:
            skipped["source_suppl"] += 1
            continue
        da = article_of(dst)
        if da is None:
            dl = dst.split("_")[0]
            if dl != sa.split("_")[0]:
                to_law[(sa, dl, REL[rel])] += 1
            else:
                skipped["internal_not_article"] += 1
            continue
        if da == sa:
            skipped["same_article"] += 1
            continue
        pairs[(sa, da, REL[rel])] += 1

    arts = sorted({x for k in pairs for x in k[:2]} | {k[0] for k in to_law})
    laws = sorted({x.split("_")[0] for x in arts} | {k[1] for k in to_law})
    li = {l: i for i, l in enumerate(laws)}
    ai = {x: i for i, x in enumerate(arts)}
    blob = {
        "meta": {
            "source": f"e-Gov 法令検索（デジタル庁）を JLaw-CiteGraph（jlawcite {a.jlawcite}）で加工",
            "license": "CC BY 4.0（データ）",
            "egov_snapshot": a.snapshot,
            "jlawcite": a.jlawcite,
            "generated": dt.date.today().isoformat(),
            "scope": "本則の条から出る引用・委任。附則からの参照は含まない",
            "counts": {"laws": len(laws), "articles": len(arts), "article_edges": len(pairs), "law_edges": len(to_law)},
            "skipped": dict(skipped),
        },
        "laws": [[l, titles.get(l, "")] for l in laws],
        "arts": [[li[x.split("_")[0]], x.split("_", 1)[1]] for x in arts],
        "e": [[ai[s], ai[d], r, n] for (s, d, r), n in sorted(pairs.items())],
        "l": [[ai[s], li[d], r, n] for (s, d, r), n in sorted(to_law.items())],
    }
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_bytes(gzip.compress(json.dumps(blob, ensure_ascii=False, separators=(",", ":")).encode(), 9))
    print(json.dumps(blob["meta"], ensure_ascii=False, indent=1))
    print(f"→ {a.out} {a.out.stat().st_size / 2**20:.1f}MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())

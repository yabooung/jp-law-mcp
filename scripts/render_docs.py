"""README・DATA_LICENSE の数値と日付を data/ と eval/results/ から埋める（文書がいつもデータと合うように）。

文書の中の値は `<!--v:キー-->値<!--/v-->` で囲む（コメントは表示されない）。data/ の 3 ファイルと SOURCE.json が
同じ e-Gov スナップショット・同じ jlawcite の版でなければ止める（3 ファイルは同じ検索DB 1 つから作る決まり）。

    python scripts/render_docs.py          # 書き換える
    python scripts/render_docs.py --check  # 古い文書があれば終了コード 1
"""
from __future__ import annotations

import argparse
import gzip
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ["README.md", "DATA_LICENSE.md"]
MARK = re.compile(r"<!--v:([^>]+?)-->(.*?)<!--/v-->", re.S)


def _n(x: int) -> str:
    return f"{x:,}"


def _pct(r: dict, places: int = 1) -> str:
    return "100%" if r["k"] == r["n"] else f"{r['k'] / r['n'] * 100:.{places}f}%"


def _kn(r: dict) -> str:
    return f"{r['k']:,}/{r['n']:,}"


def values(root: Path = ROOT) -> dict[str, str]:
    load = lambda f: json.loads(gzip.decompress((root / "data" / f).read_bytes()))
    graph, names, st = load("graph.json.gz"), load("law_names.json.gz"), load("structure.json.gz")
    src = json.loads((root / "data/SOURCE.json").read_text(encoding="utf-8"))
    seen = {("graph", graph["meta"]["egov_snapshot"], graph["meta"]["jlawcite"]),
            ("law_names", names["meta"]["egov_snapshot"], names["meta"]["jlawcite"]),
            ("structure", st["snapshot"], st.get("jlawcite")), ("SOURCE.json", src["snapshot"], src["jlawcite"])}
    if len({(s, j) for _, s, j in seen}) != 1:
        raise SystemExit(f"data/ のスナップショット・版がそろっていない: {sorted(seen)}")

    gc, nc = graph["meta"]["counts"], names["meta"]["counts"]
    mb = lambda f: f"{(root / 'data' / f).stat().st_size / 1e6:.1f}MB"
    v = {
        "snapshot": src["snapshot"], "jlawcite": src["jlawcite"],
        "graph.article_edges": _n(gc["article_edges"]), "graph.law_edges": _n(gc["law_edges"]),
        "graph.articles": _n(gc["articles"]), "graph.mb": mb("graph.json.gz"),
        "structure.laws": _n(len(st["laws"])),
        "structure.articles": _n(sum(len(x[3].split(";")) for x in st["laws"].values() if x[3])),
        "structure.mb": mb("structure.json.gz"),
    }
    # 種類がその月に 0 件でも文書のキーは残す（施行予定の改題がない月がある）
    v |= {f"names.{k}": "0" for k in ("canonical", "abbrev", "alias", "old_name", "promulgation", "new_name")}
    v |= {f"names.{k}": _n(c) for k, c in nc.items()}
    for split in ("dev", "test"):
        r = json.loads((root / f"eval/results/verify_{split}.json").read_text(encoding="utf-8"))
        a, b, c = r["A"], r["B"], r["C"]
        v |= {f"{split}.found": _pct(a["found"]), f"{split}.found_kn": _kn(a["found"]),
              f"{split}.false_alarm": _pct(a["false_alarm"], 2), f"{split}.false_alarm_kn": _kn(a["false_alarm"]),
              f"{split}.flagged": "100%" if b["flagged"]["k"] == b["flagged"]["n"] else _pct(b["flagged"]),
              f"{split}.flagged_kn": _kn(b["flagged"]),
              f"{split}.C_info": f"{c['by_mark'].get('ℹ', 0) / c['citations'] * 100:.1f}%",
              f"{split}.date": r["date"], f"{split}.cases": _n(r["cases"])}
    # AI が書いた答えでの確認（eval/gate_eval.mjs の holdout を一度だけ測った結果）
    g = json.loads((root / "eval/results/gate_holdout.json").read_text(encoding="utf-8"))
    marks, codes = g["by_mark"], g["by_code"]
    checked = marks.get("✅", 0) + marks.get("❌", 0)
    v |= {"gate.date": g["date"], "gate.citations": _n(g["citations"]), "gate.checked": _n(checked),
          "gate.checked_pct": f"{checked / g['citations'] * 100:.1f}%", "gate.no_name": _n(codes.get("no_law_name", 0)),
          "gate.missing": _n(marks.get("❌", 0))}
    return v


def render(name: str, text: str, v: dict[str, str]) -> str:
    def mark(m: re.Match) -> str:
        if m[1] not in v:
            raise KeyError(f"{name}: 知らないキー {m[1]!r}")
        return f"<!--v:{m[1]}-->{v[m[1]]}<!--/v-->"
    return MARK.sub(mark, text)


def main(argv: list[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--root", type=Path, default=ROOT)
    a = ap.parse_args(argv)
    v = values(a.root)
    stale = []
    for name in DOCS:
        p = a.root / name
        old = p.read_bytes().decode("utf-8")   # バイトで読み書きして改行を変えない
        new = render(name, old, v)
        if new != old:
            stale.append(name)
            if not a.check:
                p.write_bytes(new.encode("utf-8"))
    if stale:
        print(("古い: " if a.check else "更新: ") + ", ".join(stale), file=sys.stderr)
    return 1 if a.check and stale else 0


if __name__ == "__main__":
    sys.exit(main())

"""e-Gov スナップショット（jlawcite の jp_nodes.jsonl）から、全法令の条・項・号の形と法令番号を抜き出して data/structure.json.gz を作る。

verify_citations は条・項・号の実在をこのファイルで確かめ、e-Gov API は抜粋とスナップショット後の改正の確認にだけ使う
（CONTRIBUTING.md「外部 API の使い方」）。評価（eval/verify_eval.mjs）も同じファイルを使う。

形式: {"snapshot": "YYYY-MM-DD", "laws": {law_id: [題名, 法令番号, 現行=1/廃止=0, "条:項数:項ごとの号数:表の項;…"]}}
  例 "33:5:0,2,2:" = 第33条は 5 項、第2項・第3項に号が 2 つずつ、表の項なし。"36_2:1::1" = 第36条の2 は 1 項で、第1項が表。

    python scripts/export_structure.py --nodes <jlawcite のパイプライン出力 jp_nodes.jsonl> --snapshot 2026-09-27
"""
from __future__ import annotations

import argparse
import gzip
import json
import re
from collections import defaultdict
from pathlib import Path

ID = re.compile(r"^(?P<law>[^_]+)_a(?P<art>[0-9-]+)(?:_p(?P<p>\d+))?(?:_i(?P<i>\d+))?$")
TABLE = re.compile("次の表|同表|上欄|下欄")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--nodes", type=Path, required=True)
    ap.add_argument("--snapshot", required=True, help="e-Gov スナップショットの日付（jlawcite release_stats.json の egov_snapshot）")
    ap.add_argument("--out", type=Path, default=Path("data/structure.json.gz"))
    a = ap.parse_args()
    paras: dict[str, int] = {}                                                  # law|art → 項数
    items: dict[str, dict[int, int]] = defaultdict(lambda: defaultdict(int))  # law|art → 項 → 号数
    tables: dict[str, set[int]] = defaultdict(set)
    order: dict[str, list[str]] = defaultdict(list)
    laws: dict[str, list] = {}
    with a.nodes.open(encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            if r["type"] == "Law":
                laws[r["law_id"]] = [r.get("law_title") or r.get("title"), r.get("promulgation_no") or "", 1 if r.get("is_active", True) else 0]
                continue
            if r["section"] != "main" or r["type"] not in ("Article", "Paragraph", "Item"):
                continue
            m = ID.match(r["id"])
            if not m:
                continue
            art = m["art"].replace("-", "_")
            key = f"{r['law_id']}|{art}"
            if key not in paras:
                order[r["law_id"]].append(art)
                paras[key] = 0
            if r["type"] == "Paragraph":
                paras[key] = max(paras[key], int(m["p"]))
                if TABLE.search(r.get("text") or ""):
                    tables[key].add(int(m["p"]))
            elif r["type"] == "Item" and m["p"] and m["i"]:
                items[key][int(m["p"])] = max(items[key][int(m["p"])], int(m["i"]))
    out = {}
    for law_id, meta in laws.items():
        parts = []
        for art in order.get(law_id, []):
            key = f"{law_id}|{art}"
            p = paras[key]
            its = [items[key].get(i, 0) for i in range(1, max([p, *items[key].keys()]) + 1)]
            while its and its[-1] == 0:
                its.pop()
            parts.append(f"{art}:{p}:{','.join(map(str, its))}:{','.join(map(str, sorted(tables[key])))}")
        out[law_id] = [*meta, ";".join(parts)]
    a.out.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(a.out, "wt", encoding="utf-8") as g:
        json.dump({"snapshot": a.snapshot, "laws": out}, g, ensure_ascii=False, separators=(",", ":"))
    print(f"法令 {len(out)}, 条 {sum(len(v) for v in order.values())} → {a.out} ({a.out.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()

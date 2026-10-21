"""評価用: jlawcite の検索DBから本則の条・項・号の本文を work/eval_texts.json.gz に書き出す（約 50MB、同梱しない）。

答えの評価（eval/answer_eval.mjs）は、条文を e-Gov ではなくこのファイルから返す「スナップショット・モード」の
サーバーで行う（環境変数 JP_LAW_MCP_SNAPSHOT_TEXTS、src/sources/snapshot.ts）。e-Gov に問い合わせずに 50 問を回すため。
運用中のサーバー・npm パッケージはこのモードを使わない（スナップショットは月 1 回なので「現行」と言えない）。

形式: {"snapshot", "jlawcite", "laws": {law_id: [題名, 法令番号, 種別, 施行日, 版ID, [[条, [[項番号, 本文, [[号名, 本文]…]]…]]…]]}}

    python scripts/export_texts.py --db <jp_search.sqlite> --out work/eval_texts.json.gz
"""
from __future__ import annotations

import argparse
import gzip
import json
import sqlite3
import sys
from pathlib import Path


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", type=Path, required=True)
    ap.add_argument("--out", type=Path, default=Path("work/eval_texts.json.gz"))
    a = ap.parse_args()
    meta = json.loads(a.db.with_name(a.db.name + ".json").read_text(encoding="utf-8"))
    con = sqlite3.connect(f"file:{a.db.as_posix()}?mode=ro", uri=True)
    laws = {lid: [t, n or "", ty or "", e or "", m or "", []] for lid, t, n, ty, e, m in
            con.execute("SELECT law_id, title, promulgation_no, law_type, enforcement_date, mst_id FROM laws")}
    arts: dict[tuple[str, str], list] = {}
    paras: dict[str, list] = {}
    q = "SELECT id, type, law_id, article_path, paragraph_num, text, parent_id FROM nodes " \
        "WHERE section = 'main' AND type IN ('Article', 'Paragraph', 'Item') ORDER BY rowid"
    for nid, typ, lid, art, pnum, text, parent in con.execute(q):
        if lid not in laws or not art:
            continue
        key = (lid, art.replace("-", "_"))
        if typ == "Article":
            if key not in arts:
                arts[key] = []
                laws[lid][5].append([key[1], arts[key]])
        elif typ == "Paragraph":
            p = [pnum or 1, (text or "").replace("\n", ""), []]
            paras[nid] = p
            arts.setdefault(key, []).append(p)
        elif parent in paras:   # 号: 本文は「一\n法令\n法律、…」（号名・見出し・本文。イロハも同じ本文の中）
            head, _, rest = (text or "").partition("\n")
            paras[parent][2].append([head, rest.replace("\n", "　")])
    a.out.parent.mkdir(parents=True, exist_ok=True)
    blob = {"snapshot": meta["snapshot"], "jlawcite": meta["jlawcite"], "laws": laws}
    a.out.write_bytes(gzip.compress(json.dumps(blob, ensure_ascii=False, separators=(",", ":")).encode(), 6))
    print(f"法令 {len(laws)}, 条 {len(arts)} → {a.out} ({a.out.stat().st_size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

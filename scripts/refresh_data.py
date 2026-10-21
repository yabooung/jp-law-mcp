"""data/ の 3 ファイルを jlawcite の最新スナップショットに合わせて作り直す（毎日の GitHub Actions と手元で同じもの）。

jlawcite は毎月 e-Gov から作り直して Hugging Face に日付のタグを付けて出す。そのたびに graph・law_names・structure を
同じ検索DB 1 つから作り、どの DB から作ったか（index/MANIFEST.json）を data/SOURCE.json に書く。

    python scripts/refresh_data.py --check                  # 最新の MANIFEST が data/SOURCE.json と違えば changed=true
    python scripts/refresh_data.py --work work              # 最新を取ってきて data/ を作り直す（jlawcite が必要）
    python scripts/refresh_data.py --work work --db <jp_search.sqlite>   # 手元の DB から（隣の .json が MANIFEST）

取ってくるのは Hugging Face の MANIFEST・検索DB（xz 約 110MB）・正解ファイルだけで、e-Gov には問い合わせない。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

HF = os.environ.get("JLAWCITE_HF_REPO", "yabooung/jp-law-citation-graph")
ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "data" / "SOURCE.json"
KEYS = ("snapshot", "as_of", "jlawcite", "git_rev", "sha256")   # MANIFEST から SOURCE.json に写すもの


def url(path: str, revision: str = "main") -> str:
    return f"https://huggingface.co/datasets/{HF}/resolve/{revision}/{path}"


def get(u: str) -> bytes:
    req = urllib.request.Request(u, headers={"User-Agent": "jp-law-mcp/refresh"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def current() -> dict:
    return json.loads(SOURCE.read_text(encoding="utf-8")) if SOURCE.exists() else {}


def run(*cmd: str) -> None:
    print("$", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True, cwd=ROOT)


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--work", type=Path, default=ROOT / "work")
    ap.add_argument("--db", type=Path, help="手元の jlawcite 検索DB（省略すると最新を jlawcite download で取る）")
    a = ap.parse_args()

    if a.check:
        latest = json.loads(get(url("index/MANIFEST.json")))
        have = current()
        changed = any(latest.get(k) != have.get(k) for k in KEYS)
        print(f"latest {latest['snapshot']} (as_of {latest['as_of']}, jlawcite {latest['jlawcite']}, {latest['sha256'][:12]}) / "
              f"data {have.get('snapshot')} ({have.get('sha256', '')[:12]}) → {'changed' if changed else 'unchanged'}")
        if out := os.environ.get("GITHUB_OUTPUT"):
            with open(out, "a", encoding="utf-8") as f:
                f.write(f"changed={'true' if changed else 'false'}\nsnapshot={latest['snapshot']}\n")
        return 0

    a.work.mkdir(parents=True, exist_ok=True)
    db = a.db
    if db is None:
        tag = json.loads(get(url("index/MANIFEST.json")))["snapshot"]
        db = a.work / "jp_search.sqlite"
        run("jlawcite", "download", "--snapshot", tag, "--db", str(db))
    m = json.loads(db.with_name(db.name + ".json").read_text(encoding="utf-8"))   # jlawcite download が書く MANIFEST
    tag = m["snapshot"]
    gold = a.work / "nta_gold.jsonl"
    gold.write_bytes(get(url("eval/nta_gold.jsonl", m.get("revision", tag))))
    common = ["--db", str(db), "--jlawcite", m["jlawcite"], "--snapshot", tag]
    run(sys.executable, "scripts/export_graph.py", *common)
    run(sys.executable, "scripts/export_names.py", *common)
    run(sys.executable, "scripts/export_structure.py", *common)
    SOURCE.write_text(json.dumps({"hf_dataset": HF, **{k: m[k] for k in KEYS}}, ensure_ascii=False, indent=1) + "\n",
                      encoding="utf-8", newline="\n")
    print(f"data/ ← jlawcite {m['jlawcite']} · e-Gov {tag} (as_of {m['as_of']}), gold → {gold}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""国税庁の基本通達の番号と見出しを集めて data/tsutatsu.json.gz を作る（verify_citations が通達番号の実在を確かめる）。

国税庁ホームページ「法令解釈通達」の目次から各章のページをたどり、行の頭にある通達番号（「33-1の2」「9-4-8」
「181〜223共-6」）と見出しを抜き出す。e-Gov のような一括ダウンロードがないので、ページを一つずつ受け取る
（2026-10-22 利用者承認: 「50 件を超える取得はスナップショットで」の例外。間隔 6 秒、HTTP 200 以外・エラーページへの
転送を受けたらすぐ止める。受け取ったページは --cache に残し、やり直しは続きから）。通達はめったに変わらないので、
毎日の更新には入れず、手で時々作り直す。

    python scripts/export_tsutatsu.py --cache work/nta_cache            # 目次だけ受け取って、受け取るページ数を数える
    python scripts/export_tsutatsu.py --cache work/nta_cache --fetch    # 全部受け取って data/tsutatsu.json.gz を作る

出典表示: 国税庁ホームページ「法令解釈通達」（https://www.nta.go.jp/law/tsutatsu/menu.htm）を加工して作成
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import html
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from pathlib import Path

BASE = "https://www.nta.go.jp"
UA = "jp-law-mcp (+https://github.com/yabooung/jp-law-mcp; notice index snapshot)"
INTERVAL = 6.0
TARGETS = {
    "所得税基本通達": "/law/tsutatsu/kihon/shotoku/01.htm",
    "法人税基本通達": "/law/tsutatsu/kihon/hojin/01.htm",
    "消費税法基本通達": "/law/tsutatsu/kihon/shohi/01.htm",
    "相続税法基本通達": "/law/tsutatsu/kihon/sisan/sozoku2/01.htm",
    "財産評価基本通達": "/law/tsutatsu/kihon/sisan/hyoka_new/01.htm",
}
# 行の頭の通達番号: 「33-1の2」「9-4-8」「36・37共-1」「181〜223共-6」「2-1の2」
NUM = re.compile(r"^((?:\d+(?:の\d+)?(?:[・~]\d+(?:の\d+)?)*共?)(?:-\d+(?:の\d+)*)+)(?:\s|$|[（(])")


class Stop(Exception):
    pass


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s)
    return re.sub(r"[‐‑‒–—―−－ー]", "-", s).replace("～", "~").replace("〜", "~")


def decode(b: bytes) -> str:
    for enc in ("utf-8", "cp932"):
        try:
            return b.decode(enc)
        except UnicodeDecodeError:
            continue
    return b.decode("utf-8", "replace")


last = [0.0]


def get(path: str, cache: Path) -> str:
    f = cache / (path.strip("/").replace("/", "_"))
    if f.exists():
        return decode(f.read_bytes())
    wait = INTERVAL - (time.monotonic() - last[0])
    if wait > 0:
        time.sleep(wait)
    req = urllib.request.Request(BASE + path, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            final, status, ctype, body = r.geturl(), r.status, r.headers.get("content-type", ""), r.read()
    except urllib.error.HTTPError as e:
        raise Stop(f"{path}: HTTP {e.code}")
    except Exception as e:  # noqa: BLE001 — 接続できないときも止まる
        raise Stop(f"{path}: {e}")
    finally:
        last[0] = time.monotonic()
    if status != 200 or "/error/" in final or "html" not in ctype:
        raise Stop(f"{path}: {status} {final} {ctype}")
    f.write_bytes(body)
    return decode(body)


def chapter_pages(index_path: str, text: str) -> list[str]:
    folder = index_path.rsplit("/", 1)[0] + "/"
    out: list[str] = []
    for href in re.findall(r'href="([^"#]+)(?:#[^"]*)?"', text):
        p = href if href.startswith("/") else folder + href
        if p.startswith(folder) and p.endswith(".htm") and "/kaisei/" not in p and p != index_path and p not in out:
            out.append(p)
    return out


def text_lines(text: str) -> list[str]:
    body = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", text, flags=re.S)
    # 番号は「<strong>30</strong><strong>－10　</strong>」のように強調で分かれていることがある。行の中の飾りの札は消し、他の札で行を分ける
    body = re.sub(r"</?(?:strong|b|em|span|a|font|sup|sub|ruby|rt|rp)(?:\s[^>]*)?>", "", body, flags=re.I)
    return [x for x in (norm(html.unescape(y)).strip() for y in re.sub(r"<[^>]+>", "\n", body).split("\n")) if x]


def items(text: str) -> dict[str, str]:
    lines = text_lines(text)
    out: dict[str, str] = {}
    for i, line in enumerate(lines):
        m = NUM.match(line)
        if not m or line[m.end(1):].strip().startswith("削除"):   # 削除された番号は実在とみなさない
            continue
        title = lines[i - 1] if i and lines[i - 1].startswith("(") else ""
        out.setdefault(m[1], title[:60])
    return out


# 財産評価基本通達は「1」「20-2」のように枝のない番号もある。目次に「20-2　地積規模の大きな宅地の評価」の形で全部並ぶので、目次から読む
SIMPLE = re.compile(r"^(\d+(?:-\d+)*(?:の\d+)?)\s+(\S.*)$")
INDEX_ONLY = {"財産評価基本通達"}


def index_items(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in text_lines(text):
        m = SIMPLE.match(line)
        if m and not m[2].startswith("削除"):
            out.setdefault(m[1], m[2][:60])
    return out


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", type=Path, required=True)
    ap.add_argument("--fetch", action="store_true", help="章のページも全部受け取る（なければ目次だけ）")
    ap.add_argument("--out", type=Path, default=Path("data/tsutatsu.json.gz"))
    a = ap.parse_args()
    a.cache.mkdir(parents=True, exist_ok=True)
    notices: dict[str, dict] = {}
    try:
        plans = {name: chapter_pages(path, get(path, a.cache)) for name, path in TARGETS.items()}
        for name, pages in plans.items():
            print(f"{name}: {len(pages)} ページ")
        print(f"合計 {sum(len(p) for p in plans.values())} ページ（受け取り済み {sum(1 for p in plans.values() for x in p if (a.cache / x.strip('/').replace('/', '_')).exists())}）")
        if not a.fetch:
            return 0
        for name, pages in plans.items():
            found: dict[str, str] = index_items(get(TARGETS[name], a.cache)) if name in INDEX_ONLY else {}
            for i, p in enumerate(pages, 1):
                for k, v in items(get(p, a.cache)).items():
                    found.setdefault(k, v)
                if i % 20 == 0:
                    print(f"  {name} {i}/{len(pages)}", flush=True)
            notices[name] = {"url": BASE + TARGETS[name], "items": found}
            print(f"{name}: 通達番号 {len(found)}", flush=True)
    except Stop as e:
        print(f"止めました（国税庁のサイトが通常と違う応答）: {e}")
        return 1
    blob = {"meta": {"source": "国税庁ホームページ「法令解釈通達」（https://www.nta.go.jp/law/tsutatsu/menu.htm）を加工して作成",
                     "fetched": dt.date.today().isoformat(), "counts": {k: len(v["items"]) for k, v in notices.items()}},
            "notices": notices}
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_bytes(gzip.compress(json.dumps(blob, ensure_ascii=False, separators=(",", ":")).encode(), 9))
    print(f"→ {a.out} ({a.out.stat().st_size / 1024:.0f}KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

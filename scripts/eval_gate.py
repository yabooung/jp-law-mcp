"""データを新しいスナップショットに替えたとき、引用確認の dev 評価が前回より悪くなっていないかを確かめる。

    python scripts/eval_gate.py --base <前回の verify_dev.json> --new eval/results/verify_dev.json

どれかが 0.5 ポイント以上悪くなったら終了コード 1（毎日の更新はコミットせずに止まり、Actions が失敗を知らせる）。
法令の改正で数件動くのはふつうなので、閾値はゆるめにしてある。良くなる方向は止めない。test は判定に使わない。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

MAX_DROP = 0.005
# (表示名, 取り出し方, 大きいほど良いなら 1・小さいほど良いなら -1)
CHECKS = [
    ("正解の条を取り出せた割合", ("A", "found", "rate"), 1),
    ("正しい引用への警告率", ("A", "false_alarm", "rate"), -1),
    ("入れた誤りを見つけた割合", ("B", "flagged", "rate"), 1),
    ("見つけた理由が正しい割合", ("B", "right_reason", "rate"), 1),
]


def dig(d: dict, path: tuple[str, ...]) -> float:
    for k in path:
        d = d[k]
    return float(d)


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", type=Path, required=True)
    ap.add_argument("--new", type=Path, required=True)
    a = ap.parse_args()
    base, new = (json.loads(p.read_text(encoding="utf-8")) for p in (a.base, a.new))
    failed = False
    for label, path, sign in CHECKS:
        b, n = dig(base, path), dig(new, path)
        bad = (b - n) * sign >= MAX_DROP
        failed |= bad
        print(f"{'NG' if bad else 'ok'}  {label}: {b:.4f} → {n:.4f}")
    print("dev 評価が悪くなったので反映しない" if failed else "dev 評価 ok")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

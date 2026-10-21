"""Claude デスクトップなどに入れる拡張（.mcpb）を作る。中身は npm パッケージと同じ（npm pack の結果）＋本番用の依存。

    python scripts/build_mcpb.py            # → work/jp-law-mcp-<版>.mcpb

版は package.json から。mcpb/manifest.json の version はここで書き換える。
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NPX = "npx.cmd" if sys.platform == "win32" else "npx"
NPM = "npm.cmd" if sys.platform == "win32" else "npm"


def run(*cmd: str, cwd: Path) -> str:
    return subprocess.run(cmd, cwd=cwd, check=True, capture_output=True, text=True, encoding="utf-8").stdout


def main() -> int:
    version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    work = ROOT / "work"
    stage = work / "mcpb"
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir(parents=True)
    tgz = run(NPM, "pack", "--pack-destination", str(work), cwd=ROOT).strip().splitlines()[-1]
    with tarfile.open(work / tgz) as t:
        t.extractall(stage, filter="data")
    pkg = stage / "package"
    run(NPM, "install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", cwd=pkg)
    manifest = json.loads((ROOT / "mcpb" / "manifest.json").read_text(encoding="utf-8"))
    manifest["version"] = version
    (pkg / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    out = work / f"jp-law-mcp-{version}.mcpb"
    run(NPX, "-y", "@anthropic-ai/mcpb", "validate", str(pkg / "manifest.json"), cwd=pkg)
    run(NPX, "-y", "@anthropic-ai/mcpb", "pack", str(pkg), str(out), cwd=work)
    print(f"{out} ({out.stat().st_size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

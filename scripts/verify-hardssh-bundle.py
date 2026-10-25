#!/usr/bin/env python3
"""verify-hardssh-bundle.py —— 校验 pack-hardssh.sh 产出的 APK 内置目录。

用法:
    python scripts/verify-hardssh-bundle.py dist/hardssh [--expect-version 0.2.13]

校验项（任一失败即非零退出）:
  · 包名/版本/入口与 cordis.patch.yml 存在；
  · node_modules 里 ssh2 / ws 存在；
  · 不含 src/、lib/types/、*.d.ts、*.map、*.node、符号链接；
  · 不含 .bin（pnpm/npm 的链接目录）；
  · 体积在合理范围（< 30MB），避免误把 src 或整棵宿主 node_modules 装进来。
"""
import argparse
import json
import os
import sys

REQUIRED = [
    "package.json",
    "cordis.patch.yml",
    "lib/index.js",
    "lib/fs.js",
    "lib/subprocess.js",
    "lib/client.js",
    "node_modules/ssh2/package.json",
    "node_modules/ws/package.json",
]

FORBIDDEN_DIRS = ("src", "lib/types", "node_modules/.bin")
FORBIDDEN_SUFFIXES = (".d.ts", ".d.mts", ".d.cts", ".map", ".node")
MAX_BYTES = 30 * 1024 * 1024


def fail(msg: str) -> None:
    print(f"FAIL: {msg}", file=sys.stderr)
    raise SystemExit(1)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("bundle")
    ap.add_argument("--expect-version")
    ap.add_argument("--expect-integrity")
    args = ap.parse_args()

    root = os.path.abspath(args.bundle)
    if not os.path.isdir(root):
        fail(f"not a directory: {root}")

    for rel in REQUIRED:
        if not os.path.isfile(os.path.join(root, rel)):
            fail(f"missing {rel}")

    pkg = json.load(open(os.path.join(root, "package.json"), encoding="utf-8"))
    if pkg.get("name") != "@xiaopb/dsh-hardssh":
        fail(f"unexpected package name: {pkg.get('name')}")
    version = str(pkg.get("version", ""))
    if args.expect_version and version != args.expect_version:
        fail(f"version mismatch: {version} != {args.expect_version}")

    patch = (pkg.get("dsh") or {}).get("bundle", {}).get("patch")
    if patch and not os.path.isfile(os.path.join(root, patch)):
        fail(f"dsh.bundle.patch points to missing file: {patch}")

    for rel in FORBIDDEN_DIRS:
        if os.path.exists(os.path.join(root, rel)):
            fail(f"forbidden directory present: {rel}")

    total = 0
    files = 0
    for dirpath, dirnames, filenames in os.walk(root):
        for d in dirnames:
            if os.path.islink(os.path.join(dirpath, d)):
                fail(f"symlink: {os.path.join(dirpath, d)}")
        for name in filenames:
            path = os.path.join(dirpath, name)
            rel = os.path.relpath(path, root).replace(os.sep, "/")
            if os.path.islink(path):
                fail(f"symlink: {rel}")
            if name.endswith(FORBIDDEN_SUFFIXES):
                fail(f"forbidden file: {rel}")
            total += os.path.getsize(path)
            files += 1
            if total > MAX_BYTES:
                fail(f"bundle too large (> {MAX_BYTES // 1048576} MB) at {rel}")

    meta_path = os.path.join(root, "hardssh-bundle.json")
    meta = {}
    if os.path.isfile(meta_path):
        meta = json.load(open(meta_path, encoding="utf-8"))
        if args.expect_integrity and meta.get("npmIntegrity") != args.expect_integrity:
            fail(f"integrity mismatch: {meta.get('npmIntegrity')} != {args.expect_integrity}")
        if args.expect_version and meta.get("version") != args.expect_version:
            fail(f"metadata version mismatch: {meta.get('version')}")
    else:
        fail("missing hardssh-bundle.json (run scripts/pack-hardssh.sh)")

    print(
        f"OK hardssh bundle: @xiaopb/dsh-hardssh@{version}, "
        f"{files} files, {total / 1048576:.1f} MB, integrity={meta.get('npmIntegrity','?')[:24]}…"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

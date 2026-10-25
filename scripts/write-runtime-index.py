#!/usr/bin/env python3
"""write-runtime-index.py —— 生成 cloud update 用的 runtime-index.json。

由 publish-release 在 tag 构建里调用。索引只描述运行时（hardssh 不在索引里）。

用法:
  python scripts/write-runtime-index.py \
    --repo Soodok/Deepseek-Harness-Local-Android \
    --tag v1.4.20 \
    --meta runtime-dist/runtime-meta-arm64-v8a/runtime-meta.json \
    --meta runtime-dist/runtime-meta-x86_64/runtime-meta.json \
    --app-version-code 270 \
    --key-id runtime-2026-10 \
    --out release/runtime-index.json

URL 规则:
  · 指向本 tag 的不可变资产：.../releases/download/<tag>/runtime-<abi>.zip
  · 同时给出 gh-proxy 前缀版本；App 按用户偏好排序尝试。
"""
import argparse
import json
import os
import sys
import time


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--tag", required=True)
    ap.add_argument("--meta", action="append", required=True, help="runtime-meta.json（可多次）")
    ap.add_argument("--app-version-code", type=int, default=0)
    ap.add_argument("--key-id", default="runtime-2026-10")
    ap.add_argument("--proxy-base", default="https://gh-proxy.org/")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    packages = {}
    for path in args.meta:
        meta = json.load(open(path, encoding="utf-8"))
        abi = meta.get("abi")
        if not abi:
            print(f"write-runtime-index: {path} missing abi", file=sys.stderr)
            return 1
        direct = (
            f"https://github.com/{args.repo}/releases/download/"
            f"{args.tag}/runtime-{abi}.zip"
        )
        urls = [direct]
        if args.proxy_base:
            urls.append(args.proxy_base.rstrip("/") + "/" + direct)
        packages[abi] = {
            "version": meta.get("version", ""),
            "builtAt": int(meta.get("builtAt") or 0),
            "sha256": meta.get("sha256", ""),
            "size": int(meta.get("size") or 0),
            "unpackedBytes": int(meta.get("unpackedBytes") or 0),
            "urls": urls,
        }

    if not packages:
        print("write-runtime-index: no runtime meta", file=sys.stderr)
        return 1

    doc = {
        "schema": 1,
        "generatedAt": int(time.time()),
        "tag": args.tag,
        "repo": args.repo,
        "keyId": args.key_id,
        "minAppVersionCode": args.app_version_code,
        "runtime": packages,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"runtime-index: {args.out} (tag={args.tag}, abis={sorted(packages)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())

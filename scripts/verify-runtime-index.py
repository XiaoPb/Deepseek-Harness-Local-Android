#!/usr/bin/env python3
"""verify-runtime-index.py —— 发布前校验 runtime-index.json 的结构与签名。

用法:
  python scripts/verify-runtime-index.py \
    --index release/runtime-index.json \
    --sig release/runtime-index.json.sig \
    --pubkey /tmp/runtime-index-pub.pem \
    --repo XiaoPb/Deepseek-Harness-Local-Android \
    --tag v1.4.20 \
    --abi arm64-v8a --abi x86_64

检查:
  · detached 签名可被公钥验证（openssl dgst）；
  · tag/repo 与当前发布一致；
  · 每个 ABI 的 url 指向本 tag 的不可变 runtime-<abi>.zip；
  · sha256/size/unpackedBytes > 0，minAppVersionCode > 0。
"""
import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile


def fail(msg: str) -> None:
    print(f"FAIL: {msg}", file=sys.stderr)
    raise SystemExit(1)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--index", required=True)
    ap.add_argument("--sig", required=True)
    ap.add_argument("--pubkey", required=True)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--tag", required=True)
    ap.add_argument("--abi", action="append", required=True)
    args = ap.parse_args()

    for p in (args.index, args.sig, args.pubkey):
        if not os.path.isfile(p):
            fail(f"missing file: {p}")

    sig = base64.b64decode(open(args.sig, "rb").read())
    fd, sig_path = tempfile.mkstemp(suffix=".bin")
    os.close(fd)
    try:
        with open(sig_path, "wb") as f:
            f.write(sig)
        p = subprocess.run(
            ["openssl", "dgst", "-sha256", "-verify", args.pubkey,
             "-signature", sig_path, args.index],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        if p.returncode != 0:
            fail("signature verification failed: " + p.stderr.decode("utf-8", "replace"))
    finally:
        os.unlink(sig_path)

    doc = json.load(open(args.index, encoding="utf-8"))
    if doc.get("schema") != 1:
        fail(f"unexpected schema: {doc.get('schema')}")
    if doc.get("tag") != args.tag:
        fail(f"tag mismatch: {doc.get('tag')} != {args.tag}")
    if doc.get("repo") != args.repo:
        fail(f"repo mismatch: {doc.get('repo')} != {args.repo}")
    if int(doc.get("minAppVersionCode") or 0) <= 0:
        fail("minAppVersionCode missing")

    runtime = doc.get("runtime") or {}
    for abi in args.abi:
        entry = runtime.get(abi)
        if not entry:
            fail(f"no runtime entry for {abi}")
        expected = (
            f"https://github.com/{args.repo}/releases/download/"
            f"{args.tag}/runtime-{abi}.zip"
        )
        if expected not in (entry.get("urls") or []):
            fail(f"{abi}: urls must include {expected}")
        for k in ("sha256", "size", "unpackedBytes"):
            if not entry.get(k):
                fail(f"{abi}: missing {k}")
        if len(entry.get("sha256", "")) != 64:
            fail(f"{abi}: sha256 is not 64 hex chars")

    print(
        f"OK runtime-index: tag={args.tag} abis={args.abi} "
        f"minAppVersionCode={doc.get('minAppVersionCode')} keyId={doc.get('keyId')}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

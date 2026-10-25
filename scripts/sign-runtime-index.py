#!/usr/bin/env python3
"""sign-runtime-index.py —— 用 EC P-256 私钥对 runtime-index.json 原始字节签名。

产物是 base64 的 detached ECDSA 签名（`runtime-index.json.sig`）；
App 用内置公钥做 SHA256withECDSA 验签。

用法:
  python scripts/sign-runtime-index.py --key keystore/runtime-index-signing-key.pem \
      --in release/runtime-index.json --out release/runtime-index.json.sig
  python scripts/sign-runtime-index.py --verify --pubkey pub.pem \
      --in release/runtime-index.json --sig release/runtime-index.json.sig

依赖 openssl（CI ubuntu 与本地 Git Bash 均自带）。
"""
import argparse
import base64
import os
import subprocess
import sys
import tempfile


def run(cmd: list[str]) -> None:
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        raise SystemExit(
            f"openssl failed ({p.returncode}): {p.stderr.decode('utf-8', 'replace')}"
        )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", required=True)
    ap.add_argument("--out", dest="dst")
    ap.add_argument("--key")
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--pubkey")
    ap.add_argument("--sig")
    args = ap.parse_args()

    if args.verify:
        if not (args.pubkey and args.sig):
            print("--verify requires --pubkey and --sig", file=sys.stderr)
            return 2
        sig_raw = base64.b64decode(open(args.sig, "rb").read())
        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(sig_raw)
            sig_path = f.name
        try:
            run(["openssl", "dgst", "-sha256", "-verify", args.pubkey,
                 "-signature", sig_path, args.src])
        finally:
            os.unlink(sig_path)
        print(f"signature OK: {args.sig}")
        return 0

    if not (args.key and args.dst):
        print("signing requires --key and --out", file=sys.stderr)
        return 2
    with tempfile.NamedTemporaryFile(delete=False) as f:
        sig_path = f.name
    try:
        run(["openssl", "dgst", "-sha256", "-sign", args.key,
             "-out", sig_path, args.src])
        sig = open(sig_path, "rb").read()
        os.makedirs(os.path.dirname(os.path.abspath(args.dst)), exist_ok=True)
        open(args.dst, "wb").write(base64.b64encode(sig))
    finally:
        os.unlink(sig_path)
    print(f"signed: {args.dst} ({len(sig)} bytes ECDSA)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

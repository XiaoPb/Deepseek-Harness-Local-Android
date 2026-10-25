#!/usr/bin/env python3
"""verify-apk-assets.py —— 校验 full/noruntime APK 的资产形态。

用法:
  python scripts/verify-apk-assets.py app-debug.apk --expect-package full --expect-abi arm64-v8a

检查:
  · assets/runtime/MANIFEST.json 存在且 schema/package/abi 正确；
  · full：必须含 assets/runtime.zip，且 hash/size 与 manifest 一致；bin/node e_machine 匹配 ABI；
  · noruntime：不得含 assets/runtime.zip；tag URL 必须有 sha，`/latest/` URL 必须没有 sha；
  · 两种形态都必须含 assets/hardssh/{lib/index.js,node_modules/ssh2,ws}。
"""
import argparse
import hashlib
import json
import sys
import zipfile

EM = {"arm64-v8a": 183, "x86_64": 62}


def fail(msg: str) -> None:
    print(f"FAIL: {msg}", file=sys.stderr)
    raise SystemExit(1)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("apk")
    ap.add_argument("--expect-package", choices=["full", "noruntime"], required=True)
    ap.add_argument("--expect-abi", required=True)
    args = ap.parse_args()

    with zipfile.ZipFile(args.apk) as z:
        names = set(z.namelist())
        for rel in (
            "assets/hardssh/lib/index.js",
            "assets/hardssh/node_modules/ssh2/package.json",
            "assets/hardssh/node_modules/ws/package.json",
        ):
            if rel not in names:
                fail(f"missing {rel}")

        if "assets/runtime/MANIFEST.json" not in names:
            fail("missing assets/runtime/MANIFEST.json")
        man = json.loads(z.read("assets/runtime/MANIFEST.json"))
        if man.get("schema") != 2:
            fail(f"unexpected manifest schema: {man.get('schema')}")
        if man.get("package") != args.expect_package:
            fail(f"package mismatch: {man.get('package')} != {args.expect_package}")
        if man.get("abi") != args.expect_abi:
            fail(f"abi mismatch: {man.get('abi')} != {args.expect_abi}")

        runtime = man.get("runtime") or {}
        has_zip = "assets/runtime.zip" in names
        if args.expect_package == "full":
            if not has_zip:
                fail("full package missing assets/runtime.zip")
            import os
            import tempfile

            fd, tmp = tempfile.mkstemp(suffix=".zip")
            os.close(fd)
            h = hashlib.sha256()
            try:
                with z.open("assets/runtime.zip") as f, open(tmp, "wb") as out:
                    for b in iter(lambda: f.read(1 << 20), b""):
                        h.update(b)
                        out.write(b)
                if h.hexdigest() != runtime.get("sha256"):
                    fail("runtime.zip sha256 mismatch with manifest")
                size = z.getinfo("assets/runtime.zip").file_size
                if runtime.get("size") and size != runtime["size"]:
                    fail(f"runtime.zip size mismatch: {size} != {runtime['size']}")
                with zipfile.ZipFile(tmp) as rz:
                    node = rz.read("bin/node")[:20]
                    if node[:4] != b"\x7fELF":
                        fail("runtime bin/node is not ELF")
                    got = int.from_bytes(node[18:20], "little")
                    want = EM[args.expect_abi]
                    if got != want:
                        fail(f"runtime bin/node e_machine={got}, expected {want}")
            finally:
                os.unlink(tmp)
        else:
            if has_zip:
                fail("noruntime package must not contain assets/runtime.zip")
            urls = runtime.get("urls") or []
            if not urls:
                fail("noruntime package has no runtime download URL")
            rolling = any("/latest/" in u for u in urls)
            if rolling and runtime.get("sha256"):
                fail("rolling latest URL must not carry a pinned sha (App resolves via index)")
            if not rolling and not runtime.get("sha256"):
                fail("tag-pinned runtime URL must carry sha256")

        hard = man.get("hardssh") or {}
        if not hard.get("version"):
            fail("manifest hardssh.version missing")

    print(
        f"OK {args.apk}: {args.expect_package}/{args.expect_abi}, "
        f"runtime={runtime.get('version')} hardssh={hard.get('version')}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

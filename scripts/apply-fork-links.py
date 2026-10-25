#!/usr/bin/env python3
"""apply-fork-links.py —— 构建期把自动更新链接里的上游仓库替换为 Fork 仓库。

用法:
    python scripts/apply-fork-links.py --in <模板> --out <输出> [--repo OWNER/REPO]

规则:
  · 仓库来源优先级：--repo > $GITHUB_REPOSITORY > $GITHUB_REPOSITORY_OWNER > 默认
    `Soodok/Deepseek-Harness-Local-Android`；
  · owner 是 Soodok 时原样输出（不执行替换）；
  · 否则把文本里的 `Soodok/Deepseek-Harness-Local-Android` 全部替换为
    `<owner>/Deepseek-Harness-Local-Android`（正则，逐字匹配仓库路径）。

只处理自动更新链接（GitHub API / releases 页面 / 下载 URL），不碰文档里的说明链接。
"""
import argparse
import os
import re
import sys

DEFAULT_REPO = "Soodok/Deepseek-Harness-Local-Android"
PATTERN = re.compile(r"Soodok/Deepseek-Harness-Local-Android")
FIXED_NAME = "Deepseek-Harness-Local-Android"


def resolve_repo(explicit: str | None) -> tuple[str, bool]:
    raw = (explicit or os.environ.get("GITHUB_REPOSITORY") or "").strip()
    if not raw:
        owner = (os.environ.get("GITHUB_REPOSITORY_OWNER") or "").strip()
        raw = f"{owner}/{FIXED_NAME}" if owner else DEFAULT_REPO
    if "/" not in raw:
        print(f"apply-fork-links: invalid repo '{raw}', fallback to {DEFAULT_REPO}", file=sys.stderr)
        raw = DEFAULT_REPO
    owner = raw.split("/", 1)[0]
    if owner.lower() == "soodok":
        return DEFAULT_REPO, False
    return f"{owner}/{FIXED_NAME}", True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", required=True)
    ap.add_argument("--out", dest="dst", required=True)
    ap.add_argument("--repo", help="OWNER/REPO（默认读 GITHUB_REPOSITORY）")
    args = ap.parse_args()

    if not os.path.isfile(args.src):
        print(f"apply-fork-links: template not found: {args.src}", file=sys.stderr)
        return 1

    target, replace = resolve_repo(args.repo)
    text = open(args.src, encoding="utf-8").read()
    if replace:
        text, n = PATTERN.subn(target, text)
        print(f"apply-fork-links: {DEFAULT_REPO} -> {target} ({n} occurrence(s))")
    else:
        print(f"apply-fork-links: upstream repo, no replacement ({target})")

    os.makedirs(os.path.dirname(os.path.abspath(args.dst)), exist_ok=True)
    with open(args.dst, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())

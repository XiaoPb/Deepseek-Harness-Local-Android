#!/usr/bin/env python3
"""v1.4.19 · issue #40：polyfill v4 语义测试（WebView 96 模拟环境）。

不测 Python（patch 逻辑很简单），测 **polyfill JS 本身**：把
patch-webview-polyfill.py 里的 <script> 内容抽出来，在 Node vm 沙箱里构造一个
「Chrome 96」环境（有 AbortController/AbortSignal 原型，但缺 reason /
throwIfAborted / any / timeout），逐条断言补齐后的行为。

运行: node scripts/probes/_test_webview_polyfill_v4.mjs
"""
print("见配套 .mjs（本文件仅说明用途）")

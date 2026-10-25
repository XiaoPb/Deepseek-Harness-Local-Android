#!/usr/bin/env bash
# generate-index-key.sh —— 生成运行时索引签名用的 EC P-256 密钥对（本地一次性）。
#
# 用法:
#   scripts/generate-index-key.sh [私钥路径] [公钥路径]
#
# 产物:
#   keystore/runtime-index-signing-key.pem         私钥（keystore/ 已 gitignore，绝不提交）
#   keystore/runtime-index-signing-key.pem.base64  私钥的 base64（填入 GitHub Secret
#                                                  RUNTIME_INDEX_SIGNING_KEY）
#   app/src/main/res/raw/runtime_index_pub.pem     公钥（提交到仓库，App 内置验签）
#
# 轮换: 重新运行会覆盖；App 侧保留旧公钥一段时间（keyId 双密钥）。
set -euo pipefail

KEY="${1:-keystore/runtime-index-signing-key.pem}"
PUB="${2:-app/src/main/res/raw/runtime_index_pub.pem}"
mkdir -p "$(dirname "$KEY")" "$(dirname "$PUB")"

if [ ! -f "$KEY" ]; then
  openssl ecparam -name prime256v1 -genkey -noout -out "$KEY"
fi
chmod 600 "$KEY"
openssl ec -in "$KEY" -pubout -out "$PUB" 2>/dev/null

if base64 --help 2>&1 | grep -q -- '-w'; then
  base64 -w0 "$KEY" > "$KEY.base64"
else
  base64 "$KEY" | tr -d '\n' > "$KEY.base64"
fi

echo "private key : $KEY  (gitignored — never commit)"
echo "public key  : $PUB  (commit this)"
echo "github secret RUNTIME_INDEX_SIGNING_KEY = contents of $KEY.base64"

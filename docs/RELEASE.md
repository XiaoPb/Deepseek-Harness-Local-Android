# 发布与签名（Android）

本文覆盖 **正式包签名材料的保管**、**GitHub Actions Secrets 配置**、**CI 构建 debug + release** 与 **tag 发布**。

> **签名即身份。** Android 只允许同包名、同证书的 APK 覆盖安装。
> 一旦对外发过正式包，**私钥必须永久保管**；换新 key 等于换应用身份，老用户只能卸载重装。
> 当前仓库**尚未用这把新 key 发布过任何版本**——如果还能找到旧的 `dsh-release.keystore`
>（证书 `CN=DSH Mobile`，SHA-256 `d28ca4f5…92c8`），应优先改用旧 key，避免老用户被迫卸载。

---

## 1. 本机签名材料（绝不入库）

全部位于 `keystore/`（`.gitignore` 已忽略）：

| 文件 | 说明 |
|---|---|
| `dsh-release.keystore` | PKCS12，RSA 4096 / SHA256withRSA，有效期 10000 天，alias `dsh-release` |
| `dsh-release.credentials.txt` | 口令、alias、证书指纹（已限制为当前用户可读） |
| `dsh-release.keystore.base64` | 给 GitHub Secret 用的单行 base64（添加后可从工作目录删除，但要确保另有加密备份） |
| `release.properties` | 本地 Gradle 签名配置（`assembleRelease` 自动签名） |

当前证书 SHA-256 **不写入仓库**：值在本地 `keystore/dsh-release.credentials.txt` 的
`certSHA256` 行（GitHub 变量 `RELEASE_CERT_SHA256` 填它；公开指纹，不是私钥）。
获取方式：

```bash
apksigner verify --print-certs app-release.apk | grep 'SHA-256 digest'
# 或
keytool -list -v -keystore keystore/dsh-release.keystore | grep SHA256
```

> ⚠️ **GitHub Secrets 不是备份**：Secret 保存后无法再读回，Secret 丢失 + 本机磁盘损坏 =
> 私钥永久丢失。请把整个 `keystore/` 至少备份到 **两处**（密码管理器附件 / 加密压缩包 +
> 离线介质），并用不同密码保护。备份里必须包含 `dsh-release.keystore` 和口令。

本地构建正式包（可选）：

```powershell
# keystore/release.properties 已就绪，Gradle 会自动读取
gradle -p . assembleRelease -Pabi=arm64-v8a
# 产物：app/build/outputs/apk/release/app-release.apk（已签名）
& "$env:ANDROID_HOME\build-tools\36.0.0\apksigner" verify --print-certs `
  app\build\outputs\apk\release\app-release.apk
```

CI 使用环境变量覆盖本地配置：`DSH_RELEASE_STORE_FILE` / `DSH_RELEASE_STORE_PASSWORD` /
`DSH_RELEASE_KEY_ALIAS` / `DSH_RELEASE_KEY_PASSWORD`。

---

## 2. 在 GitHub 添加（一次性）

仓库 → **Settings → Secrets and variables → Actions**。

### 2.1 Repository secrets（必填，构建正式签名包用）

| Secret | 值 |
|---|---|
| `RELEASE_KEYSTORE_BASE64` | `keystore/dsh-release.keystore.base64` 的全部内容（单行） |
| `RELEASE_STORE_PASSWORD` | `dsh-release.credentials.txt` 里的 `storePassword` |
| `RELEASE_KEY_ALIAS` | `dsh-release` |
| `RELEASE_KEY_PASSWORD` | 同 `storePassword`（PKCS12 密钥库两者相同） |

用 GitHub CLI 添加（本机未安装 `gh`，可在任意装有 `gh` 的机器执行）：

```bash
gh secret set RELEASE_KEYSTORE_BASE64 -R XiaoPb/Deepseek-Harness-Local-Android \
  < keystore/dsh-release.keystore.base64
gh secret set RELEASE_STORE_PASSWORD -R XiaoPb/Deepseek-Harness-Local-Android
gh secret set RELEASE_KEY_ALIAS -R XiaoPb/Deepseek-Harness-Local-Android --body dsh-release
gh secret set RELEASE_KEY_PASSWORD -R XiaoPb/Deepseek-Harness-Local-Android
```

重新生成 base64（换 key 或误删时）：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("keystore/dsh-release.keystore")) |
  Set-Content keystore/dsh-release.keystore.base64 -NoNewline
```

```bash
# Linux / macOS
base64 < keystore/dsh-release.keystore | tr -d '\n' > keystore/dsh-release.keystore.base64
```

### 2.2 Repository variable（建议，防签错 key）

**Settings → Secrets and variables → Actions → Variables → New repository variable**

| Variable | 值 |
|---|---|
| `RELEASE_CERT_SHA256` | 本地 `keystore/dsh-release.credentials.txt` 的 `certSHA256`（公开指纹，不是私钥） |

CI 每次 tag 构建都会用 `apksigner verify --print-certs` 比对实际签名证书；不一致直接失败，
杜绝「secret 被换成了另一把 key 却照常发布」。

### 2.3 可选加固：Environment 保护

若要防止误发，可建 **Settings → Environments → `release`**，加 Required reviewers，
并把上面 4 个 secret 移到该 Environment（此时需要把 workflow 的 `build-apk` 或新发布 job
指定 `environment: release`）。当前实现使用 Repository secrets，保持简单。

### 2.4 运行时索引签名（复用 APK 正式签名密钥）

`publish-release` 为 `runtime-index.json` 生成 detached 签名（默认 `SHA256withRSA`），
App 用内置公钥（`app/src/main/res/raw/runtime_index_pub.pem`）验签。

**不新增 secret**：CI 在发布 job 里从 `RELEASE_KEYSTORE_BASE64` 解码 PKCS12，用
`RELEASE_STORE_PASSWORD` + `RELEASE_KEY_ALIAS` 取出私钥，签名后立即删除临时文件。
因此索引签名与 APK 签名使用同一把 key：

- 优点：Fork 只需配置已有的 4 个 `RELEASE_*` secret；不会出现“APK 能装、索引验不过”的错配。
- 代价：这把私钥的用途增加了一项（签索引）；换 key 时索引公钥也要随新 APK 一起换。
  App 侧兼容 EC P-256 与 RSA 两种公钥，便于轮换。

`app/src/main/res/raw/runtime_index_pub.pem` 由正式 keystore 的证书导出（公钥，非私钥）：

```bash
openssl pkcs12 -in keystore/dsh-release.keystore -nokeys -clcerts \
  -passin pass:"$STORE_PASSWORD" -out /tmp/cert.pem
openssl x509 -in /tmp/cert.pem -pubkey -noout > app/src/main/res/raw/runtime_index_pub.pem
```

`RUNTIME_INDEX_KEY_ID`（Repository Variable，可选）默认 `release-keystore`。

---

## 3. CI 行为

| 触发 | 行为 |
|---|---|
| push 分支（非 main）/ PR | 构建双架构 × full/noruntime 的 **debug**（无签名材料时不跑 release） |
| push `main` | 构建 8 个变体，**edge 只发布 4 个 noruntime**（debug + release）；缺 secrets 时该腿失败并提示 |
| 每日 01:30（Asia/Shanghai） | 构建 8 个变体 → **preview** 滚动预发布（debug + release，full + noruntime；需要 `RELEASE_*` 才能凑齐 8 个） |
| push tag `v<major>.<minor>.<patch>` | 必须 `RELEASE_*`；构建 8 个 APK + 2 个 runtime zip，`publish-release` 发布并归档 |
| tag 且通过 | `runtime-index.json`（+ `.sig`，Phase 4）随 tag 发布；App 通过 `releases/latest/download/` 读取 |

产物命名（文件名带当前 `versionName`）：

```
# main / edge（ref = main）
dsh-android-main-arm64-v8a-v1.4.19-debug.apk
dsh-android-main-arm64-v8a-v1.4.19-release.apk
dsh-android-main-arm64-v8a-v1.4.19-debug-noruntime.apk
dsh-android-main-arm64-v8a-v1.4.19-release-noruntime.apk
# x86_64 同理

# tag 发布
dsh-android-v1.4.19-arm64-v8a-debug.apk
dsh-android-v1.4.19-arm64-v8a-release.apk
dsh-android-v1.4.19-arm64-v8a-debug-noruntime.apk
dsh-android-v1.4.19-arm64-v8a-release-noruntime.apk
# x86_64 同理
runtime-arm64-v8a.zip
runtime-x86_64.zip
```

> - `full` 包（无后缀）含 `runtime.zip`，离线可用；`noruntime` 包首启按 `MANIFEST.json` 的链接下载运行时。
> - tag 的 noruntime 包指向本 tag 的 `runtime-<abi>.zip` 并钉 sha；edge/preview 指向 `releases/latest/download/runtime-<abi>.zip`（无 sha，App 取 index 校验）。
> - 运行时资产只随 tag Release 发布；**不新增 runtime 渠道**。运行时单独更新 = 打一个新 tag。
> - 内置 hardssh 由上游 `XiaoPb/dsh-hardssh` Release 的 tgz 组装，本仓库不发布 hardssh 包。
> - **edge** 是滚动 pre-release（tag `edge`），只含 4 个 noruntime 包；**preview** 每日滚动，含 8 个变体。
> - Fork 的自动更新链接在构建期由 `scripts/apply-fork-links.py` 自动替换为 `<owner>/Deepseek-Harness-Local-Android`；上游 Soodok 不替换。

---

## 4. 发版步骤

1. **升版本**（同一版本只能有一个正式包）：
   `app/build.gradle.kts` 的 `versionCode` +1、`versionName` 改为新版本。
2. 跑本地检查：`python scripts/check-i18n.py`、测试、`assembleDebug`。
3. 提交并推送 `main` —— CI 会自动更新 **edge** 预发布（debug + release），用户可先装；每日 01:30（Asia/Shanghai）还会自动产出 **preview**（debug，只保留最新一版资产）。
4. 正式发版：打 tag 并推送（tag 必须是严格的 `v<major>.<minor>.<patch>` 且等于 `v<versionName>`；
   `v*.*.*-*` 这类预发布 tag 被 CI 直接拒绝）：

   ```bash
   git tag v1.4.18
   git push origin v1.4.18
   ```

5. CI 完成后在 Releases 查看：`*-release.apk` 为正式包，`*-debug.apk` 仅测试。

### 发布说明（自动生成）

`publish-release` / `publish-edge` 都会调用
[scripts/generate-release-notes.sh](../scripts/generate-release-notes.sh)，通过 `body_path`
写入 Release 说明；手写的版本说明统一归档在 [docs/release-notes/](release-notes/)，不再放仓库根目录（CI 说明由脚本生成，不需要手写）：

- **变更范围**：tag 发布取「上一个语义化版本 tag → 当前 tag」；edge 取 `edge → HEAD`；
  没有旧 tag 时取最近 30 个提交。
- **变更分类**：按 conventional commit 前缀分为 新功能 / 问题修复 / 性能优化 / 重构 /
  构建与依赖 / CI/CD / 文档 / 测试 / 代码风格 / 其他。
- **版本信息**：tag、`versionName`、`versionCode`、提交短 SHA、提交数量、构建时间（UTC）、
  架构、签名方式、内置 `dsh-hardssh` 的 npm 版本（`HARDSSH_VERSION`）。
- **安装包表**：每个 APK 的架构（arm64-v8a / x86_64）、类型（release / debug）、大小、
  SHA-256，方便下载后校验。
- **签名与安装**：正式 / debug 签名区别、旧证书升级失败时的处理、`apksigner` 校验命令；
  末尾附「本次更新贡献者」与「项目累计 Top 10」两张清单，以及 GitHub compare 链接；CI 通过 GitHub API（compare / contributors）把贡献者映射为 GitHub 账号链接，API 不可用时回退纯 git 名称。

> 该脚本只读 git 历史与 `apk/` 产物，不接触任何签名材料；tag 发布仍会先校验
> tag 与 `versionName` 一致。

---

## 5. 签名校验（任何拿到 APK 的人都能做）

```bash
apksigner verify --print-certs dsh-android-v1.4.18-arm64-v8a-release.apk
# Signer #1 certificate SHA-256 digest: <应与 RELEASE_CERT_SHA256 完全一致>
```

应输出与 `RELEASE_CERT_SHA256` 一致的值；`apksigner verify` 同时校验 v1/v2/v3 完整性。

---

## 6. 换 key / 丢 key

- **换 key**：替换 `keystore/dsh-release.keystore` 与 4 个 secret、更新 `RELEASE_CERT_SHA256`；
  已装旧版的用户**无法覆盖升级**，需在 Release 说明中明确要求卸载重装。
- **丢 key**：无法恢复。能做的只有生成新 key、换应用身份，并承担用户卸载成本。
- **保管要点**：两处备份、加密存储、口令与 keystore 分开存放；不要提交到任何 git 仓库，
  不要发到聊天工具；CI 只在 tag 构建时解码，构建结束后的临时文件随 runner 销毁。

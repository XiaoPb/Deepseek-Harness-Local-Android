# DSH Mobile v1.4.19

> 这一版的主题是**运行时分发解耦**：APK 不再只有“227MB 全量包”一种选择，
> 运行时、SSH 插件都可以独立更新；同时给 Fork 用户补上了自动更新链接。

## 1. 两种 APK：完整包 / 简单包

| 包 | 文件名 | 体积（实测） | 行为 |
|---|---|---|---|
| 完整包 | `dsh-android-v1.4.19-<abi>-release.apk` | 146–147 MB | 内置运行时，装完离线可用 |
| 简单包 | `…-release-noruntime.apk` | 22–24 MB | 首启按 `MANIFEST.json` 下载运行时（支持 gh-proxy） |

简单包首次启动会弹出确认框（体积、建议 Wi-Fi、下载完整包入口），确认后才下载；
之后 **App 升级不会重复下载运行时**。

## 2. 运行时独立更新

- 运行时由 `scripts/build-runtime.sh` 统一构建：collect → zod/SONAME 去重 → 补丁/闭包/架构校验。
- 本次 `runtime-<abi>.zip` 从 219.5 MB 降到约 127 MB。
- tag Release 内提供 `runtime-index.json` + `.sig`；App 从
  `releases/latest/download/runtime-index.json` 读取并**验签**后才使用。
- 索引签名复用 APK 正式签名密钥（RSA-4096），不新增 secret。
- 运行时安装改为 staging + `engine.old` 回滚；新运行时若连续两次未进入 Healthy，自动回滚旧版本。

## 3. hardssh 与运行时解耦

- 不再把 `@xiaopb/dsh-hardssh` 塞进 `runtime.zip`；APK 单独带 `assets/hardssh/`。
- 构建时从上游 `XiaoPb/dsh-hardssh` 的 Release 取 tgz，并用 npm integrity 校验。
- 运行时重装后，启动时由 `HardsshInstaller` 自动补装（实测 SSH 工作区正常出现）。
- 本仓库不发布 hardssh zip/tgz；需要手动安装时从上游 Release 下载 tgz 后执行：
  `dsh plugin --profile web add <tgz>`。

## 4. Fork 自动更新链接

- 构建期 `scripts/apply-fork-links.py` 把模板里的
  `Soodok/Deepseek-Harness-Local-Android` 替换为 `<owner>/Deepseek-Harness-Local-Android`；
- Soodok 上游构建原样不改；
- 运行时 manifest / index / Release 页面都跟随 Fork。

## 5. 验证

- CI：build-hardssh、collect-runtime ×2、build-apk（full/noruntime × 2 ABI）全绿。
- Release 12 个资产齐全；索引签名用正式证书公钥验签通过；runtime zip 的 sha256/size
  与 index/manifest 一致。
- MuMu（x86_64 / Android 12）：安装 release-noruntime → 首启确认框 → 下载 127MB →
  解压 → hardssh 安装 → 引擎 Healthy，左侧栏出现「SSH 工作区」。

## 升级提示

- 正式包与 debug 包签名不同，不能互相覆盖；本次 MuMu 测试即因旧包是 debug 签名而卸载重装。
- 旧版 debug 用户升级正式版需要卸载（会清数据）；正式版之间可直接覆盖。

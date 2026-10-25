# DSH Mobile v1.4.17

> **紧急修复**：WebView 里点「下载」没反应的问题（issue #37）——不下载、不报错、无提示。

## 下载按钮无反应 —— 已修复

**现象**：会话「文件」标签页（文件分享插件）里点「下载」，什么都不会发生。Android 10 设备上设置里也找不到任何存储权限可以授权。

### 根因（issue #37 的四组证据链，全部实锤）

两层缺陷叠加，所以点按钮**静默失败**：

1. **宿主 WebView 从未实现下载监听**。Android WebView 收到下载请求时，如果没有设置
   `DownloadListener`，会**直接丢弃**——不下载、不报错。我们的 WebView 从第一版起就没接。
2. **没有可授权的存储权限**。App 只声明了「所有文件访问」（Android 11+ 权限），在
   Android 10 上这个权限不存在；普通存储权限又没声明。设置页里那个开关压根不出现。

### 修复

- **单文件下载**（http/https 直链）→ 交给系统 DownloadManager 代写，**任何系统版本都
  不需要存储权限**；带上了 WebView 会话的 Cookie（否则下载到的是登录页 HTML）和
  User-Agent；文件名按 RFC 5987 解析（中文文件名正确）。
- **打包下载**（插件的 blob 方式）→ 这类请求根本到不了 DownloadListener（blob 只存在
  于页面内存里）。注入了页面级 JS 桥：拦截 `a[download]` 的 blob 点击，转 base64 交给
  原生落盘到公共 Download/ 目录。
  - Android 10+ 走 MediaStore（无需权限）；Android 8/9 需要运行时存储权限
    （已按 `maxSdkVersion=28` 声明，首次使用会弹授权）。

**实测验证**（Android 16 模拟器，通过 WebView 调试协议在真实页面环境里执行）：

- blob 路径两次：文件正确落在 `Download/dsh-blob-test.txt`，内容逐字节一致 ✅
- http 直链：DownloadListener 正确触发、成功入队系统下载管理器 ✅
- JS 桥在页面导航后依然注册 ✅

### 已知限制（如实说明）

- **大文件打包下载**：blob 转基64会占用约 1.3× 文件大小的内存，几十 MB 以上的打包
  下载在低内存设备上可能失败。单文件下载不受影响。后续版本可以改成分块传输。
- blob 桥拦截的是 `a[download]` 点击；如果插件用其他方式触发下载（如 JS 直接
  `location` 赋值 blob URL），会收到「该下载方式未被拦截」的提示。

## 感谢

感谢 **@yiming-0098** —— 这份 issue 的质量是教科书级的：对 APK 的 dex 做字符串扫描
证明没有 DownloadListener、解析二进制 Manifest 证明没有存储权限、用 `cmd appops`
证明 MANAGE_EXTERNAL_STORAGE 在 Android 10 上无效、甚至实测引擎进程写 /sdcard 被拒。
最难得的是**推翻了「必须加存储权限」的第一直觉**，指出 DownloadManager 方案
在 Android 10 上零权限可用——修复方案直接采纳。

## 其他

- 回归测试 312 项全过；i18n 三语一致
- APK：versionCode 267 / 1.4.17 / `native-code: arm64-v8a`，签名与之前一致

## 兼容性

直接覆盖安装，会话、工作区、凭据、插件全部保留。

## 交流

**QQ 交流群：`1128769016`**

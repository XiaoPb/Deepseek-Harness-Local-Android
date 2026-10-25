# DSH Mobile v1.4.7

> 这一版主要处理三件事：**恢复对话后数据被引擎写回去覆盖**、**目录选择器整条链在重启后失效**、
> **PTC（run_code）连续多日报 `libz.so.1` 缺失**。另外合入了社区贡献的登录弹窗渲染修复。

## 1. 恢复的对话「重启后又变空」——已解决

有用户反馈：外部恢复 `workspace.json` 之后，重启 App，工作区里还是空的，看起来像历史被删了，于是卸载重装。

根因是**写回竞争**。恢复功能在引擎仍在运行时写入注册表，而引擎在内存里也持有一份 `workspace.json` 快照；引擎退出时把旧快照整体回写，刚恢复的登记被原样覆盖。用户的操作顺序（恢复 → 重启 → 空）每次都命中这个时间窗。

现在的做法：

- **先停引擎再写**：设置页的「恢复对话」会先正常停止引擎（最多等 3 秒），等 800 ms 让写入落盘，再写注册表，最后拉起引擎；
- **写前备份**：注册表先复制成 `workspace.json.before-recover`，出问题可手工回滚；
- **写后留戳**：同目录落一个 `.workspace.json.recover-stamp`，方便判断这次恢复是否被后来的写入覆盖；
- **恢复后自检**：重启后比对预期的会话是否仍在注册表里，不在就明确告知，而不是安静地「恢复成功」。

## 2. 目录选择器整条链失效（`directoryPickerController is unavailable`）

用户给了非常完整的定位：装好第一次启动正常，从第二次启动开始，选择工作区必定报这个错，且 `engine.log` 里没有任何记录。

原因是 overlay 里挂的是 `dsh-host-directory-picker-auto`。它在 `apply()` 里用 `ctx.loader.create()` 动态挂载 backend 和 surface 两个 entry，然后 `await entry.fiber.await()`。这段代码跑在 `ctx.effect()` 里，**一个进程只执行一次**；任何一步抛错就回滚并抛出，Cordis 不重试，于是 `directoryPicker` 服务在整个进程生命周期内都不存在，依赖它的 `workspace-controller` 的 `inject` 永远不满足。

而 auto 的探测结论在 Android 上是**恒定的**：`platform === "linux"`（Termux node 报告 linux）+ 没有 `DISPLAY`/`WAYLAND` + 没有 `zenity`/`kdialog`，必然落到 browse 分支。

所以现在直接声明 `dsh-host-directory-picker-browse`：少一条会断的动态链，行为完全一致。插件健康探针的关键行也同步改成 browse 包名，避免误判。

## 3. PTC / run_code 找不到 `libz.so.1`

诺忆连续 7 天反馈：进入 PTC 模式后无法加载 `libz.so.1`。

PTC worker 在启动子进程前会把父进程的 env 清成墓碑表（每个 key 置 `undefined`），只保留一份白名单。v1.4.3 的补丁只做了「把 `LD_LIBRARY_PATH` 加进白名单」——但父进程自己没设置这个变量时，白名单等于放行一个空值，子进程仍然拿不到库路径。

本版加第二处补丁：在 env 墓碑构造之后，从 worker 可执行文件自身位置反推引擎根目录（`<engine>/bin/node` → `<engine>/lib:<engine>/usr/lib`），**无条件注入** `LD_LIBRARY_PATH`。这样不依赖 App 侧是否传了环境变量，也不依赖继承。

运行时已按 arm64 与 x86_64 分别重打，`MANIFEST.json` 的 sha256 同步更新。

## 4. 登录 / 「开始使用」弹窗渲染错位（社区贡献 @skynit，PR #30）

真机首次启动（无凭证）时，弹窗卡片被拉成 4.2:1，标题消失、按钮只剩一个字。

根因是视口缩放的时机：`onPageFinished` 里才把 viewport meta 改成 `initial-scale=R`，此时首屏已经按 `scale=1` 画完（弹窗就在这一帧里），随后整页缩放突变。WebView 把部分合成层（圆角裁剪卡片、`backdrop-filter`、淡入动画层）留在旧栅格里，于是卡片背景、文字、按钮各用各的缩放。

修复：

- `onPageFinished` 改为**先应用视口、再收启动遮罩**，用户看到的第一帧就是最终缩放；
- 视口生效后 120 ms，在遮罩之下切一次 `LAYER_TYPE_SOFTWARE` 丢弃栅格缓存并整页重绘，再切回硬件合成；120 ms 小于遮罩最短等待（700 ms），用户看不到这次刷新；
- 每次重栅格化写一行 `reraster: <reason>` 到 `engine.log`，方便真机核对。

**说明**：这项修复在提交方环境中完成了编译验证，但真机回归未完成（提交时设备不在线）。如果你仍能看到错位弹窗，请在群里反馈并在日志里确认有没有 `reraster:` 这一行。

## 其它

- 插件健康摘要现在写进 `engine.log`（`[health]` 前缀），用户报障时可以直接看到哪些插件处于 pending/failed。
- i18n 三语（en/zh/de）补齐恢复确认文案，426 条键值对齐。

## 验证

- 界面插件回归：侧栏 30、设置 36、右栏 28、性能 4、渲染 17 —— 共 115 项全过
- i18n 检查全过（含 Kotlin 字面量 CJK 检查）
- `compileDebugKotlin`、`assembleRelease` 均 BUILD SUCCESSFUL
- APK 校验：versionCode 258 / versionName 1.4.7 / `native-code: arm64-v8a`，签名证书 `CN=DSH Mobile`
- 运行时校验：`bin/node`、`bin/bash`、`bin/rg`、`lib/libz.so.1` 均为 AArch64；两处 PTC 补丁在包内均可见

## 兼容性

直接覆盖安装，会话、工作区、凭据、插件全部保留。

## 交流

**QQ 交流群：`1128769016`**（也可在 App 内「设置 → 关于」点击复制群号）。

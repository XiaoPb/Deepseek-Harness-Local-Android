# DSH Mobile v1.3.3

> 本次是插件稳定性与 WebView 性能修复版本：插件导致的 host service 缺失可以自动隔离恢复，
> 同时收紧窄屏 UI 插件的 DOM 观察范围，降低 1.3.x 之后的 WebView 卡顿风险。

## 插件导致工作区选择失效：自动恢复

如果安装了不兼容的第三方 dsh 插件，可能出现：

```
typert gateway: directoryPicker/list: active Service "directoryPickerController" is unavailable
```

插件加载失败时，引擎的 HTTP 端口仍可能正常监听，但目录选择、工作区控制器等 host service
已经没有实例。以前这类状态会一直留在 profile 里，清缓存和重启都不一定恢复，清数据才会消失。

v1.3.3 新增启动期插件健康探针与有限自愈：

- 检查关键 host service、Loader entry 和关键 patch 行是否真的激活；
- 按失败 entry 的 id/name 精确反查第三方 bundle；
- 只摘除能精确归因的故障插件，保留 `package.json`、lockfile 和插件文件，方便恢复；
- 单次最多自动处理 3 次，无法精确归因时不猜测、不删除用户插件；
- 自动恢复后在状态栏提示被停用的插件名，并把完整原因写进 `engine.log`。

我们用一个会重复注册 `directoryPicker` 的 fake 插件做了真实启动验证：引擎先报告 degraded，
随后自动摘除该 bundle，重启后健康标记恢复 `ok=true`，用户配置没有被清空。

## 窄屏 UI 的性能收紧

1.3.0 的窄屏布局插件此前监听整棵 DOM 的所有属性变化。AI 工作时消息流和动画会产生大量
`class/style/data` 更新，插件会反复重新定位布局、计算样式并安排下一帧。

本版把观察范围收紧到真正影响布局的属性：

- 侧栏和设置面板只观察 `aria-label/title`；
- 右侧面板只观察 `data-sidebar-right-open/data-sidebar-right-panel`；
- DOM 增删、旋转和窗口尺寸变化仍然会正确触发重新布局。

这项改动用于降低 WebView 在任务进行中和后台的额外开销。设备差异很大，若仍遇到高占用，
请附上设备型号、触发时机、插件清单和 logcat。

## runtime 架构安全校验

- App 安装/解压时校验 `bin/node` 的 ELF 架构；
- 构建 runtime 时对 arm64/x86_64 做硬断言，架构错配直接中止出包；
- 架构不匹配会显示明确错误，不再无限重启。

## 上游框架说明

上游 dsh 已发布 `0.2.1-rc.2`。本版继续使用经过 Android 专用补丁验证的
`0.2.0-rc.2` runtime；0.2.1 的适配会单独验证，避免把未经 Android 验证的新框架直接带入正式包。

## 验证

- arm64 release/debug 构建通过，正式包内 `bin/node` 为 AArch64 (`e_machine=183`)；
- plugin-health JavaScript 语法、i18n 三语门禁、窄屏 UI 回归测试全部通过；
- x86_64 模拟器正常启动 marker 为 `ok=true`，关键服务全部存在；
- fake 插件重复服务故障可以被自动摘除并恢复；
- 未在真实用户设备上复现到 CPU 满核现场，因此性能项按风险收紧发布，保留后续诊断空间。

## 安装

覆盖安装即可，用户数据和配置保留。若插件导致工作区选择失效，升级后首次启动会进行有限自愈；
若无法精确识别故障插件，App 会保留配置并把诊断写入日志，不会擅自清空数据。

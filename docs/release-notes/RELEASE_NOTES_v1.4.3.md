# DSH Mobile v1.4.3

> 本版修复两个影响正常使用的问题：`run_code` 子进程起不来、数据迁移后工作区不可用。

## 修复 `run_code` 报 `libz.so.1 not found`（issue #29）

用户反馈：重启引擎后 `run_code` 仍失败，主进程正常、但**子进程一律起不来**：

```
CANNOT LINK EXECUTABLE ".../files/engine/bin/node":
library "libz.so.1" not found
```

**根因**：`run_code` 属于 PTC 模式，它拉子进程时会**清空几乎所有继承的环境变量**，只保留一份「原生可执行文件启动所需」的白名单：

```
PATH  PATHEXT  SYSTEMROOT  WINDIR  TEMP  TMP
```

这份白名单是按 Linux / Windows 桌面环境设计的——桌面上 libz 由 ldconfig 索引，不需要额外路径。但 **Android 不是这样**：内置的 Node.js 是 bionic 动态链接二进制，依赖库全部躺在运行时自己的 `lib/` 目录，只能靠 `LD_LIBRARY_PATH` 找到。

于是出现这个矛盾现象：主引擎继承了 `LD_LIBRARY_PATH` 所以正常，而它启动的子进程被清掉了这个变量，全部链接失败。

**修法**：把 `LD_LIBRARY_PATH` 加入该白名单。改动只有一行，不影响其它平台（桌面上通常没设这个变量）。

## 修复「数据迁移完成后选工作区提示 unavailable」

用户反馈：尝试恢复之前的对话，数据移动完成后，选择工作区直接提示：

```
directoryPickerController is unavailable
```

**根因**：应用为了「卸载不丢数据」会把工作区目录软链到共享存储。升级、授权变化或数据迁移都会让**软链目标变化**，但引擎保存的工作区注册表里仍是旧的绝对路径。路径失效后：

```
工作区注册表路径失效
  → workspaceRegistry 服务起不来
  → workspace / storageDomain 连锁失败
  → directoryPickerController 缺失 → 选工作区直接报 unavailable
```

**修法**：启动时校验工作区注册表，把路径失效但能在当前工作区目录下找到同名文件夹的条目重新指向新位置。**绝不删除任何条目**——找不到对应的就保留原样，宁可让引擎报错，也不静默丢用户的工作区。

## 诊断改进

插件健康探针此前只报「required service X is unavailable」，用户和我们都不知道为什么。现在会把导致该服务缺失的那一行插件的**真实错误**一并带出来（例如 `scandir EACCES`、软链失效等），便于快速定位。

## 兼容性

直接覆盖安装即可，会话、工作区、凭据、插件全部保留。

## 交流

**QQ 交流群：`1128769016`**（也可在 App 内「设置 → 关于」点击复制群号）。

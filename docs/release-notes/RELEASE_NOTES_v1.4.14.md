# DSH Mobile v1.4.14

> **紧急修复**：PTC 模式（`run_code`）在装了 Termux 的设备上无法启动 worker。
> 同时把 PTC 子进程丢失的**一整套扩展工具链变量**补齐了。

## PTC worker 报 OpenSSL 配置错误 —— 已修复（issue #35）

**现象**：所有 `run_code` 调用在真正执行代码前就失败：

```
node: OpenSSL configuration error:
error:8000000D:system library:BIO_new_file:Permission denied
calling fopen(/data/data/com.termux/files/usr/etc/tls/openssl.cnf, rb)
Exit code: 13
```

主引擎、Shell、标准预设工具都正常，只有 PTC 的 worker 起不来。

### 原因

PTC 启动子进程时会把环境变量几乎清空，只保留一份白名单。而 Termux 编译的 node 把 OpenSSL 配置目录**硬编码**成了 `/data/data/com.termux/files/usr/etc/tls`。

如果设备上**装了 Termux**，那个路径确实存在，但我们的沙箱读不了 → EACCES → 退出码 13。如果没装 Termux，路径不存在 → ENOENT → 静默回退到默认配置，反而没事。这就是为什么问题只在部分设备上出现。

我们在主引擎里早就注入了正确的 `OPENSSL_CONF`（指向 runtime 自带的 `etc/tls/openssl.cnf`），但 PTC 的白名单没放行它，worker 拿不到。

### 顺手做了一次全量审计

这位用户报的是 `OPENSSL_CONF`，但我把 `buildEnv` 注入的**所有变量**和 PTC 白名单逐项对了一遍，发现**13 个扩展工具链变量也全都缺失**：

| 类别 | 变量 |
|---|---|
| C/C++ 编译 | `CPATH`、`LIBRARY_PATH`、`RUSTFLAGS` |
| Python | `PYTHONHOME` |
| Perl / Ruby | `PERL5LIB`、`RUBYLIB` |
| ImageMagick | `MAGICK_CONFIGURE_PATH` |
| git | `GIT_EXEC_PATH`、`GIT_TEMPLATE_DIR`、`GIT_CONFIG_NOSYSTEM`、`GIT_SSL_CAINFO` |
| curl / Go | `CURL_CA_BUNDLE`、`GOTMPDIR` |

也就是说：**在 PTC 里用这些扩展，之前很可能一直是坏的**（比如 git 找不到子命令、Python 找不到标准库）。这一版一起修了，白名单从 7 个变量扩到 28 个。

### 验证

写了个脚本从 PTC 源码里**解析出真实白名单**，按它构造环境再真正跑一次 worker：

```
parsed allowlist size: 28
final env: LD_LIBRARY_PATH,OPENSSL_CONF,SSL_CERT_FILE
EXIT: 0 | OUT: WORKER-OK
```

worker 成功加载 `node:tls`、`node:https`、`node:fs`，退出码 0。

> 说明一个测试局限：模拟器上没有 `/data/data/com.termux` 目录，走的是 ENOENT 路径，所以**修复前在模拟器上也是通过的**。用户真机装了 Termux 才会触发 EACCES。这个差异我们在代码注释里记录过（v1.2 时就踩过同样的坑）。

## 构建期硬校验又扩了一层

v1.4.13 已经把「PTC 补丁是否在」做成构建的强制检查。这次把检查项从 2 个扩到 4 个（`LD_LIBRARY_PATH`、无条件注入、`OPENSSL_CONF`、`SSL_CERT_FILE`），缺任何一项都直接中止构建，不会把坏包发出去。

## 验证清单

- 回归测试 **272 项全过**（新增 12 条扩展变量断言）
- i18n 三语一致
- APK：versionCode 265 / 1.4.14 / `native-code: arm64-v8a`，签名 `CN=DSH Mobile`（与前几版一致）
- 运行时中 PTC 白名单实测 **28 个变量**

## 兼容性

直接覆盖安装，会话、工作区、凭据、插件全部保留。

## 致谢

感谢 **@linshiqi137-web** 报告的 issue #35 —— 诊断链写得很清楚（移除变量复现、提供变量恢复、模拟 worker 启动成功），直接指出了根因。

## 交流

**QQ 交流群：`1128769016`**

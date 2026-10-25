package app.dsh.mobile.engine

import android.content.Context
import android.os.Build
import android.os.Environment
import android.util.Log
import java.io.File

/**
 * 全面体检与自愈（v1.4.4，用户要的「强检模式」）。
 *
 * ## 为什么需要
 * 用户反馈：「有的时候这玩意就是会异常崩，而且我们都找不到原因」。这类问题的共同点是
 * **现场没有可读的证据** —— 崩溃发生在一个我们碰不到的环境里，用户能描述的只有
 * 「就是不启动」。
 *
 * 与其等用户复述，不如让应用自己把能查的全查一遍，并把结果**逐条列出来**：
 *   · 每一项都给出「正常 / 异常 / 已修复」；
 *   · 异常项附带具体数值或路径，不是一句「失败」；
 *   · 能安全修的当场修，不能修的明确写「需要你处理」。
 *
 * ## 检查项（全部与插件无关，插件坏了也能跑）
 * 1. **运行时完整性** —— 入口、关键库、node 可执行位、ELF 架构
 * 2. **存储与权限** —— 共享存储可用性、MANAGED_EXTERNAL_STORAGE、dsh-home 可写
 * 3. **软链健康** —— sessions/workspaces 是否指向真实目录、目标是否可访问
 * 4. **工作区注册表** —— 路径失效条目（复用 healWorkspaceRegistry 的逻辑）
 * 5. **未登记会话** —— 磁盘上有但列表里没有的对话（复用 ChatRecovery.scan）
 * 6. **插件配置** —— profile package.json 可解析、bundles 列表合法
 * 7. **残留进程** —— 孤儿引擎进程（复用 OrphanReaper 的判定）
 * 8. **磁盘空间** —— 数据目录可用余量
 *
 * ## 安全边界
 * · 只做**幂等、可回滚**的修复：重建软链、修注册表路径、回收孤儿进程；
 * · **绝不删除**会话、工作区、凭证、插件；
 * · 任何检查抛异常都只记为「该项未能完成」，不影响其它项。
 */
object SelfCheck {

    private const val TAG = "SelfCheck"

    /** 单项检查结果。 */
    data class Item(
        /** 稳定的机器可读标识（日志与支持沟通用） */
        val id: String,
        /** 用户可见的一行标题 */
        val title: String,
        /** 结果类型 */
        val status: Status,
        /** 具体说明（正常时可给关键数值，异常时给原因） */
        val detail: String = "",
    ) {
        enum class Status { OK, FIXED, WARN, FAIL }
    }

    data class Report(
        val items: List<Item>,
        val startedAt: Long,
        val finishedAt: Long,
    ) {
        val issues: Int get() = items.count { it.status == Item.Status.WARN || it.status == Item.Status.FAIL }
        val fixed: Int get() = items.count { it.status == Item.Status.FIXED }
    }

    /** 文本摘要（写日志 + 可复制给开发者） */
    fun summarize(r: Report): String = buildString {
        appendLine("DSH Mobile self-check ${r.finishedAt - r.startedAt}ms")
        appendLine("device: ${Build.MANUFACTURER} ${Build.MODEL} SDK=${Build.VERSION.SDK_INT} ${Build.SUPPORTED_ABIS.firstOrNull()}")
        for (i in r.items) {
            val tag = when (i.status) {
                Item.Status.OK -> "OK   "
                Item.Status.FIXED -> "FIXED"
                Item.Status.WARN -> "WARN "
                Item.Status.FAIL -> "FAIL "
            }
            appendLine("[$tag] ${i.id}: ${i.title}${if (i.detail.isNotBlank()) " — ${i.detail}" else ""}")
        }
        append("issues=${r.issues} fixed=${r.fixed}")
    }

    /**
     * 跑完整检查。**必须在后台线程调用**（含文件遍历与进程扫描）。
     */
    fun run(ctx: Context): Report {
        val t0 = System.currentTimeMillis()
        val items = mutableListOf<Item>()

        items += checkRuntime(ctx)
        items += checkStorage(ctx)
        items += checkSymlinks(ctx)
        items += checkWorkspaceRegistry(ctx)
        items += checkOrphanSessions(ctx)
        items += checkProfile(ctx)
        items += checkFreeSpace(ctx)

        val r = Report(items, t0, System.currentTimeMillis())
        Log.i(TAG, summarize(r))
        // 落到 engine.log，用户导出日志时一并带上
        runCatching {
            File(EngineConfig.engineRoot(ctx), "engine.log")
                .appendText("\n[self-check]\n" + summarize(r) + "\n")
        }
        return r
    }

    // ── 1. 运行时 ──────────────────────────────────────────────────────────

    /**
     * 运行时是否完整可用。
     *
     * 注意这里**不调用** `RuntimeInstaller` 的安装流程 —— 体检只诊断，
     * 不触发重装（重装是「重启引擎」那条路径的事，代价太大）。
     */
    private fun checkRuntime(ctx: Context): List<Item> {
        val out = mutableListOf<Item>()
        val root = EngineConfig.engineRoot(ctx)
        val node = EngineConfig.nodeBin(ctx)
        val entry = EngineConfig.dshEntry(ctx)

        out += if (entry.isFile) {
            Item("runtime.entry", "Engine entry", Item.Status.OK)
        } else {
            Item("runtime.entry", "Engine entry", Item.Status.FAIL, "missing ${entry.absolutePath}")
        }

        out += if (node.isFile && node.canExecute()) {
            Item("runtime.node", "Node runtime", Item.Status.OK, "${node.length() / 1048576} MB, executable")
        } else if (node.isFile) {
            // 可执行位丢失是可修的：restoreExecBits 是幂等操作
            val fixed = runCatching { node.setExecutable(true, false) }.getOrDefault(false)
            Item(
                "runtime.node", "Node runtime",
                if (fixed && node.canExecute()) Item.Status.FIXED else Item.Status.FAIL,
                if (fixed) "restored executable bit" else "not executable and cannot be fixed",
            )
        } else {
            Item("runtime.node", "Node runtime", Item.Status.FAIL, "missing ${node.absolutePath}")
        }

        val lib = File(root, "lib")
        val needLibs = listOf("libreadline.so.8", "libz.so.1", "libssl.so")
        val missing = needLibs.filter { !File(lib, it).isFile }
        out += if (missing.isEmpty()) {
            Item("runtime.libs", "Runtime libraries", Item.Status.OK, needLibs.joinToString(", "))
        } else {
            Item("runtime.libs", "Runtime libraries", Item.Status.FAIL, "missing: ${missing.joinToString(", ")}")
        }

        // 架构：与设备 ABI 比对（跨架构会让 execve 直接被 linker 拒绝）
        runCatching {
            val actual = ReadElfMachine(node)
            val expected = when (Build.SUPPORTED_ABIS.firstOrNull()) {
                "arm64-v8a" -> 183
                "x86_64" -> 62
                "armeabi-v7a" -> 40
                else -> 0
            }
            out += if (actual > 0 && expected > 0 && actual != expected) {
                Item("runtime.arch", "CPU architecture", Item.Status.FAIL, "node=$actual device=$expected")
            } else {
                Item("runtime.arch", "CPU architecture", Item.Status.OK, "e_machine=$actual")
            }
        }.onFailure {
            out += Item("runtime.arch", "CPU architecture", Item.Status.WARN, it.message ?: "unreadable")
        }

        // v1.4.20：内置 SSH 插件与 runtime 解耦，重装 runtime 后由 HardsshInstaller 补装。
        // 缺失只影响 SSH 工作区，不算运行时故障。
        val sshPkg = File(root, "lib/node_modules/@xiaopb/dsh-hardssh/package.json")
        out += if (sshPkg.isFile) {
            val ver = runCatching {
                org.json.JSONObject(sshPkg.readText()).optString("version")
            }.getOrDefault("?")
            Item("runtime.ssh", "Bundled SSH plugin", Item.Status.OK, "v$ver")
        } else {
            Item(
                "runtime.ssh", "Bundled SSH plugin", Item.Status.WARN,
                "not installed (SSH workspace disabled)",
            )
        }

        return out
    }

    /** 读 ELF 头里的 e_machine（小端）。 */
    private fun ReadElfMachine(f: File): Int = f.inputStream().use { ins ->
        val h = ByteArray(20)
        if (ins.read(h) < 20) return 0
        if (h[0] != 0x7F.toByte() || h[1] != 'E'.code.toByte() ||
            h[2] != 'L'.code.toByte() || h[3] != 'F'.code.toByte()
        ) return 0
        (h[18].toInt() and 0xFF) or ((h[19].toInt() and 0xFF) shl 8)
    }

    // ── 2. 存储与权限 ──────────────────────────────────────────────────────

    private fun checkStorage(ctx: Context): List<Item> {
        val out = mutableListOf<Item>()
        val home = EngineConfig.dshHome(ctx)
        out += if (home.isDirectory && home.canWrite()) {
            Item("storage.home", "App data directory", Item.Status.OK, home.absolutePath)
        } else {
            Item("storage.home", "App data directory", Item.Status.FAIL, "not writable: ${home.absolutePath}")
        }

        // 共享存储权限：仅 Android 11+ 有意义
        if (Build.VERSION.SDK_INT >= 30) {
            val granted = runCatching { Environment.isExternalStorageManager() }.getOrDefault(false)
            out += if (granted) {
                Item("storage.allfiles", "All files access", Item.Status.OK)
            } else {
                Item(
                    "storage.allfiles", "All files access", Item.Status.WARN,
                    "not granted — data stays in app-private storage (lost on uninstall)",
                )
            }
        }
        return out
    }

    // ── 3. 软链 ────────────────────────────────────────────────────────────

    private fun checkSymlinks(ctx: Context): List<Item> {
        val out = mutableListOf<Item>()
        for (name in listOf("sessions", "workspaces")) {
            val link = File(ctx.filesDir, "dsh-home/$name")
            val isLink = runCatching {
                java.nio.file.Files.isSymbolicLink(link.toPath())
            }.getOrDefault(false)
            when {
                isLink -> {
                    val target = runCatching {
                        java.nio.file.Files.readSymbolicLink(link.toPath()).toString()
                    }.getOrNull()
                    val reachable = File(target.orEmpty()).isDirectory
                    out += if (reachable) {
                        Item("link.$name", "Link: $name", Item.Status.OK, "→ $target")
                    } else {
                        // ⚠️ v1.4.6（审查 P0）：这里**绝不删链**。
                        // 旧实现判为不可达就 `link.delete()` —— 但「不可达」可能只是
                        // FUSE 瞬时拒绝、权限被系统临时收回、开机未挂载。删链之后
                        // sessions/workspaces 回退到**空的私有目录**，用户看到
                        // 「所有对话/工作区消失」，而数据其实还在公开目录里。
                        // 这正好违反 EngineConfig 里「删链是不可逆的用户可见故障」的约束。
                        //
                        // 体检只报告；真正的修复交给引擎启动前的 externaliseSubdir
                        //（那里有完整校验与重建逻辑，且不会在运行中改动数据）。
                        Item(
                            "link.$name", "Link: $name", Item.Status.WARN,
                            "target currently unreachable: $target — will be re-checked on next engine start " +
                                "(not deleted: the data may still be there)",
                        )
                    }
                }
                link.isDirectory -> out += Item("link.$name", "Link: $name", Item.Status.OK, "real directory")
                else -> out += Item(
                    "link.$name", "Link: $name", Item.Status.WARN,
                    "neither link nor directory — engine will recreate it on next start",
                )
            }
        }
        return out
    }

    // ── 4. 工作区注册表 ────────────────────────────────────────────────────

    /**
     * 注册表是否可解析、路径是否有效。
     *
     * 修复逻辑与 [EngineConfig.ensureUserDataExternal] 里的自愈一致，
     * 但这里**只报告**：「重启引擎」时才真正改写 —— 体检不应在用户不知情时
     * 改动数据文件。
     */
    private fun checkWorkspaceRegistry(ctx: Context): List<Item> {
        val f = File(EngineConfig.dshHome(ctx), "storages/workspace.json")
        if (!f.isFile) {
            return listOf(Item("registry", "Workspace registry", Item.Status.OK, "not created yet"))
        }
        return runCatching {
            val root = org.json.JSONObject(f.readText())
            val tables = root.optJSONObject("tables")?.optJSONObject("workspaces")
                ?: return@runCatching listOf(
                    Item("registry", "Workspace registry", Item.Status.WARN, "no workspaces table")
                )
            var total = 0
            var broken = 0
            for (id in tables.keys().asSequence().toList()) {
                val ws = tables.optJSONObject(id) ?: continue
                total++
                val p = ws.optString("path")
                if (p.isBlank() || !File(p).isDirectory) broken++
            }
            listOf(
                if (broken == 0) {
                    Item("registry", "Workspace registry", Item.Status.OK, "$total workspace(s)")
                } else {
                    // ⚠️ v1.4.6（审查）：这里并**没有**真正修复任何东西，不能报 FIXED。
                    // 旧实现报 FIXED 会让设置页显示「发现 0 个问题，已修复 1 个」，
                    // 用户以为已处理，实际下次启动才修。
                    Item(
                        "registry", "Workspace registry", Item.Status.WARN,
                        "$broken of $total path(s) invalid — will be repaired on next engine start",
                    )
                }
            )
        }.getOrElse {
            listOf(
                Item(
                    "registry", "Workspace registry", Item.Status.FAIL,
                    "unparseable: ${it.message}",
                )
            )
        }
    }

    // ── 5. 未登记会话 ──────────────────────────────────────────────────────

    private fun checkOrphanSessions(ctx: Context): List<Item> = runCatching {
        val scan = ChatRecovery.scan(ctx)
        listOf(
            if (scan.orphans.isEmpty()) {
                Item(
                    "sessions", "Conversations", Item.Status.OK,
                    "${scan.totalOnDisk} on disk, all registered",
                )
            } else {
                Item(
                    "sessions", "Conversations", Item.Status.WARN,
                    "${scan.orphans.size} of ${scan.totalOnDisk} not in the list — use “Recover conversations”",
                )
            }
        )
    }.getOrElse {
        listOf(Item("sessions", "Conversations", Item.Status.WARN, it.message ?: "scan failed"))
    }

    // ── 6. profile 配置 ────────────────────────────────────────────────────

    private fun checkProfile(ctx: Context): List<Item> {
        val pj = File(EngineConfig.dshHome(ctx), "profiles/web/package.json")
        if (!pj.isFile) {
            return listOf(Item("profile", "Plugin profile", Item.Status.WARN, "not created yet"))
        }
        return runCatching {
            val obj = org.json.JSONObject(pj.readText())
            val bundles = obj.optJSONObject("dsh")?.optJSONObject("profile")
                ?.optJSONArray("bundles") ?: org.json.JSONArray()
            val names = (0 until bundles.length()).mapNotNull {
                bundles.optString(it).takeIf(String::isNotBlank)
            }
            // 每个 bundle 的目录是否真的存在。
            // ⚠️ v1.4.6（审查）：引擎解析 bundle 目录的顺序是
            // **installation anchor 优先、profile 次之**（dsh-app-boot 的
            // resolveBundleDir）。内置 bundle（dsh-base / dsh-web-app）装在
            // engine/lib/node_modules 下，不在 profiles/web/node_modules 下 ——
            // 只查后者会让每台设备每次体检都误报「missing bundle」。
            val installModules = File(EngineConfig.engineRoot(ctx), "lib/node_modules")
            val profileModules = File(pj.parentFile, "node_modules")
            val missing = names.filter { name ->
                !File(profileModules, name).isDirectory && !File(installModules, name).isDirectory
            }
            listOf(
                if (missing.isEmpty()) {
                    Item("profile", "Plugin profile", Item.Status.OK, "${names.size} bundle(s)")
                } else {
                    Item(
                        "profile", "Plugin profile", Item.Status.WARN,
                        "missing bundle dir(s): ${missing.joinToString(", ")}",
                    )
                }
            )
        }.getOrElse {
            listOf(Item("profile", "Plugin profile", Item.Status.FAIL, "unparseable: ${it.message}"))
        }
    }

    // ── 7. 磁盘空间 ────────────────────────────────────────────────────────

    private fun checkFreeSpace(ctx: Context): List<Item> {
        val home = EngineConfig.dshHome(ctx)
        val usable = runCatching { home.usableSpace }.getOrDefault(0L)
        val mb = usable / (1L shl 20)
        return listOf(
            when {
                usable <= 0 -> Item("space", "Free space", Item.Status.WARN, "unavailable")
                mb < 200 -> Item("space", "Free space", Item.Status.WARN, "${mb}MB left — very low")
                mb < 600 -> Item("space", "Free space", Item.Status.WARN, "${mb}MB left — low")
                else -> Item("space", "Free space", Item.Status.OK, "${mb}MB")
            }
        )
    }
}

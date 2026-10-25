package app.dsh.mobile.engine

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * 社区插件中心（v1.2.113 MVP）：一键安装 dsh 生态插件。
 *
 * dsh 的插件机制：`dsh plugin --profile web add <pkg>` 把 npm 包装进 profile。
 * 本类做两件事：
 *  1. [list] —— 远程清单（我们仓库维护的 community-plugins.json，GitHub raw），
 *     拉取失败回退内置兜底清单；
 *  2. [install] —— 引擎子进程执行官方 CLI（`--expose-internals` + buildEnv，
 *     与引擎启动同一套环境），完成后回调。
 *
 * UI 入口后续补（扩展中心页加「社区插件」块）；先通过 AgentBridge 暴露给 AI
 * （GET /plugin/list、POST /plugin/install），AI 也能自助安装。
 */
object PluginCenter {
    // v1.4.16 审查 P2：安装/卸载串行化。旧实现每次 new 一个裸 Thread 直接跑
    // pnpm —— 两个插件并发安装会同时操作同一 profile，轻则锁错误、重则
    // node_modules / pnpm-store 状态损坏。单线程执行器从根上消除并发。
    private val installExecutor = java.util.concurrent.Executors.newSingleThreadExecutor { r ->
        Thread(r, "dsh-plugin-ops").apply { isDaemon = true }
    }

    private const val TAG = "PluginCenter"

    /** 远程清单：我们仓库根目录维护，CI/手动更新；raw 直读无需鉴权 */
    private const val CATALOG_URL =
        "https://raw.githubusercontent.com/Soodok/Deepseek-Harness-Local-Android/main/community-plugins.json"

    data class PluginInfo(
        val id: String,
        val pkg: String,
        val desc: String,
        val repo: String = "",
        val version: String = "",
    )

    /** 内置兜底（远程拉不到时用；与 community-plugins.json 同步，desc 英文过 i18n 门禁）。
     *  均已核对 peerDependencies 兼容引擎 0.2.0-rc.2（2026-10-10 npm registry 实查）。 */
    /**
     * 内置精选清单（v1.4.21）—— 供 [PluginMarket] 在远端清单拉取失败时兜底，
     * 保证插件市场不空屏（离线/网络重置场景实测会空）。
     */
    fun bundledCatalog(): List<PluginMarket.Entry> = BUILTIN.map {
        PluginMarket.Entry(
            pkg = it.pkg,
            name = it.id,
            desc = it.desc,
            repo = it.repo,
            official = true,
        )
    }

    private val BUILTIN = listOf(
        PluginInfo("cost-meter", "dsh-cost-meter",
            "Session cost tracking: per-conversation/daily cost, multi-vendor price tables"),
        PluginInfo("free-search", "dsh-free-search",
            "Free web search: 24 engines (Bing/DuckDuckGo etc), no API key"),
        PluginInfo("whale-widget", "dsh-whale-widget",
            "Balance whale widget for the WebUI: balance/daily usage/peak-valley pricing"),
        PluginInfo("mcp-connector", "dsh-mcp-connector",
            "MCP connector: attach Model Context Protocol servers and search tools"),
        PluginInfo("im", "@xmanrui/dsh-im",
            "Bridge WeChat/Lark/DingTalk/QQ/Telegram/Discord into DSH"),
        PluginInfo("memory", "@openviking/dsh-memory-plugin",
            "Memory and context management across sessions"),
        PluginInfo("vision-router", "dsh-vision-router",
            "Vision router: free image understanding for text-only agents"),
        PluginInfo("genui", "@changfenhuang/dsh-genui",
            "Interactive UI components rendered in the conversation"),
        PluginInfo("rewind", "dsh-rewind-plugin",
            "In-window conversation rewind with workspace file restore"),
        PluginInfo("pet", "dsh-pet",
            "Desktop pet: the blue fat fish that refuses to leave"),
        PluginInfo("pet-bridge", "dsh-pet-bridge",
            "Android pet bridge: push DSH turn/tool status to the system overlay"),
        PluginInfo("dream-skin", "dsh-dream-skin",
            "WebUI skins: 8 iOS / Linear style themes"),
        PluginInfo("skills-manager", "@michengai/dsh-skills-manager",
            "Unified skill loading and management"),
    )

    /** 拉取远程清单；任何失败回退内置（日志留痕，不静默） */
    fun list(): List<PluginInfo> {
        val remote = runCatching {
            val conn = java.net.URL(CATALOG_URL).openConnection()
            conn.connectTimeout = 5000
            conn.readTimeout = 5000
            val text = conn.getInputStream().bufferedReader().use { it.readText() }
            parseCatalog(text) ?: throw IllegalStateException("catalog parse failed")
        }.getOrElse {
            Log.w(TAG, "catalog fetch failed (${it.message}); using builtin")
            BUILTIN
        }
        return remote
    }

    /**
     * 已安装插件包名集合（v1.2.118）。
     *
     * 读 `$DSH_HOME/profiles/web/package.json` 的 dependencies —— 那是 dsh 官方
     * plugin manager 的真实记录（`dsh plugin add` 写的就是这里）。
     * ⚠️ 必须查真实文件而非内存标记：主人实测「装完显示已安装，退出重进又能装」
     * （旧版只记 UI 内存状态，Activity 重建即丢）。
     */
    fun installedPackages(ctx: Context): Set<String> = runCatching {
        val pj = java.io.File(EngineConfig.dshHome(ctx), "profiles/web/package.json")
        if (!pj.isFile) return emptySet()
        val deps = JSONObject(pj.readText()).optJSONObject("dependencies") ?: return emptySet()
        deps.keys().asSequence().toSet()
    }.getOrElse {
        Log.w(TAG, "read installed packages failed: ${it.message}")
        emptySet()
    }

    /**
     * 已安装插件的**实际版本**（v1.4.18）—— 读
     * `$DSH_HOME/profiles/web/node_modules/<pkg>/package.json` 的 version。
     *
     * 为什么不读 profile package.json 的 dependencies spec：那是声明范围
     * （如 `^0.74.0`），pnpm 装完后即使 registry 有新版也不会动它——这正是
     * 「升级不行」的根源。真实安装版本以 node_modules 里落盘的为准
     * （pnpm symlink 布局，File 读文本自然跟随软链到 .pnpm 实体）。
     *
     * @return pkg -> version；读不到的包不出现在 map 里
     */
    fun installedVersions(ctx: Context): Map<String, String> {
        val out = mutableMapOf<String, String>()
        for (pkg in installedPackages(ctx)) {
            runCatching {
                val pj = java.io.File(
                    EngineConfig.dshHome(ctx), "profiles/web/node_modules/$pkg/package.json",
                )
                if (pj.isFile) {
                    val v = JSONObject(pj.readText()).optString("version", "")
                    if (v.isNotBlank()) out[pkg] = v
                }
            }
        }
        return out
    }

    /**
     * 实时搜索 npm 上的插件（registry search API，v1.2.118）。
     * 查询自动限定 `keywords:deepseek-harness` 生态；@deepseek-ai/ 官方内部组件
     * （引擎部件，非插件）被排除。主人在插件中心看到的列表即此实时结果。
     * @param query 用户关键词，空 = 全部生态
     * @param onDone 后台线程回调（网络失败返回空列表，UI 层回退内置精选）
     */
    fun search(query: String, onDone: (List<PluginInfo>) -> Unit) {
        Thread({
            // v1.2.118：**放开为全网 npm 搜索** —— 主人反馈「插件太少」。
            // 空查询 = 浏览 dsh 生态（keywords:deepseek-harness）；有查询词 =
            // 直接搜全网 npm（用户想装什么就搜什么，不再限定生态关键词）。
            val q = if (query.isBlank()) "keywords:deepseek-harness" else query.trim()
            val encoded = java.net.URLEncoder.encode(q, "UTF-8")
            val url = "https://registry.npmjs.org/-/v1/search?text=$encoded&size=50"
            val result = runCatching {
                val conn = java.net.URL(url).openConnection()
                conn.connectTimeout = 8000
                conn.readTimeout = 8000
                val text = conn.getInputStream().bufferedReader().use { it.readText() }
                parseSearch(text, browseMode = query.isBlank())
            }.getOrElse {
                Log.w(TAG, "npm search failed (${it.message}); empty result")
                emptyList()
            }
            onDone(result)
        }, "dsh-plugin-search").apply { isDaemon = true; start() }
    }

    private fun parseSearch(text: String, browseMode: Boolean): List<PluginInfo> = runCatching {
        val d = JSONObject(text)
        val arr = d.getJSONArray("objects")
        val out = ArrayList<PluginInfo>()
        for (i in 0 until arr.length()) {
            val p = arr.getJSONObject(i).getJSONObject("package")
            val name = p.getString("name")
            // 生态浏览（空查询）时排除官方内部组件：它们是引擎部件而非可装插件；
            // 显式搜索（用户输入了词）时不排除 —— 用户搜什么就给什么。
            if (browseMode && name.startsWith("@deepseek-ai/")) continue
            out.add(
                PluginInfo(
                    id = name.substringAfterLast('/'),
                    pkg = name,
                    desc = p.optString("description", ""),
                    version = p.optString("version", ""),
                ),
            )
        }
        out
    }.getOrDefault(emptyList())

    private fun parseCatalog(text: String): List<PluginInfo>? = runCatching {
        val arr = JSONArray(text)
        (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            PluginInfo(
                o.getString("id"),
                o.getString("package"),
                o.optString("desc", ""),
                o.optString("repo", ""),
            )
        }
    }.getOrNull()

    /**
     * 一键安装：引擎子进程执行 `dsh plugin --profile web add <pkg>`。
     * 与引擎启动同环境（buildEnv），保证 pnpm/npm registry 配置一致。
     * v1.4.18：失败命中 pnpm store 锁损坏签名时自动清缓存重试一次
     * （见 [healPnpmStore]）。
     * @param onDone (成功, 详情或错误信息) —— 在后台线程回调
     */
    fun install(ctx: Context, pkg: String, onDone: (Boolean, String) -> Unit) {
        installExecutor.execute({
            var ok = false
            var msg = "?"
            try {
                val r = runDshPluginCli(ctx, "add", pkg)
                ok = r.first
                msg = r.second
                if (!ok && isPnpmStoreLockError(msg)) {
                    val healed = healPnpmStore(ctx)
                    Log.w(TAG, "install $pkg: pnpm store lock broken; heal=$healed; retrying once")
                    val r2 = runDshPluginCli(ctx, "add", pkg)
                    ok = r2.first
                    msg = if (ok) r2.second
                    else "${r2.second} [pnpm store cache reset, still failing]"
                }
            } catch (e: Exception) {
                msg = e.message ?: "install failed"
            }
            Log.i(TAG, "install $pkg -> ok=$ok: $msg")
            onDone(ok, msg)
        })
    }

    /**
     * 卸载插件（v1.2.120）—— dsh plugin --profile web remove <pkg>。
     *
     * dsh plugin 转发给 pnpm（实测 --help 显示 pnpm 命令表），故卸载即
     * `pnpm remove`。此前插件中心只能装不能卸（主人反馈），装错/不想要的
     * 插件只能靠 CLI 手工处理。v1.4.18：与 install 共享 store 锁自愈。
     */
    fun uninstall(ctx: Context, pkg: String, onDone: (Boolean, String) -> Unit) {
        installExecutor.execute({
            var ok = false
            var msg = "?"
            try {
                val r = runDshPluginCli(ctx, "remove", pkg)
                ok = r.first
                msg = r.second
                if (!ok && isPnpmStoreLockError(msg)) {
                    val healed = healPnpmStore(ctx)
                    Log.w(TAG, "uninstall $pkg: pnpm store lock broken; heal=$healed; retrying once")
                    val r2 = runDshPluginCli(ctx, "remove", pkg)
                    ok = r2.first
                    msg = if (ok) r2.second
                    else "${r2.second} [pnpm store cache reset, still failing]"
                }
            } catch (e: Exception) {
                msg = e.message ?: "uninstall failed"
            }
            Log.i(TAG, "uninstall $pkg -> ok=$ok: $msg")
            onDone(ok, msg)
        })
    }

    /**
     * 跑一次 `dsh plugin --profile web <verb> <pkg>` 子进程（install/uninstall 共用）。
     * @param verb add / remove
     * @return (成功与否, 截断到 300 字符的 stdout 或 stderr)
     */
    private fun runDshPluginCli(ctx: Context, verb: String, pkg: String): Pair<Boolean, String> {
        val node = EngineConfig.nodeBin(ctx)
        val entry = EngineConfig.dshEntry(ctx)
        val env = EngineConfig.buildEnv(ctx, EngineConfig.DEFAULT_PORT)
        val pb = ProcessBuilder(
            node.absolutePath, "--expose-internals", entry.absolutePath,
            "plugin", "--profile", "web", verb, pkg,
        )
        pb.environment().clear()
        env.forEach { kv ->
            val i = kv.indexOf('=')
            if (i > 0) pb.environment()[kv.substring(0, i)] = kv.substring(i + 1)
        }
        val p = pb.start()
        val out = p.inputStream.readBytes()
        val err = p.errorStream.readBytes()
        return if (p.waitFor(120, TimeUnit.SECONDS)) {
            if (p.exitValue() == 0) {
                true to String(out, Charsets.UTF_8).trim().take(300)
            } else {
                false to String(err, Charsets.UTF_8).trim().take(300)
                    .ifEmpty { "exit=${p.exitValue()}" }
            }
        } else {
            p.destroy()
            false to "plugin $verb timed out (120s)"
        }
    }

    /**
     * pnpm store 锁损坏签名（v1.4.18）。用户截图报：
     * `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK`，消息原文含
     * "lock directory must be a real directory owned by the current user"，
     * 路径指向 `$HOME/.cache/pnpm-store…/locks-0`。错误码与消息双签名
     * 大小写不敏感匹配，防 pnpm 版本措辞变化。
     */
    private fun isPnpmStoreLockError(msg: String): Boolean =
        msg.contains("ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK", ignoreCase = true) ||
            msg.contains("store operation lock", ignoreCase = true)

    /**
     * 自愈 pnpm store 锁损坏（v1.4.18）。成因两类：
     * ① Root 模式残留属主 —— 引擎以 uid 0 写过 `.cache/pnpm-*`，
     *    切回普通模式后 app uid 无法持锁（报"owned by the current user"）；
     * ② 安装中途进程被杀，留下悬空锁目录。
     *
     * `.cache` 下以 pnpm 开头的条目（store 本体 / operation-locks /
     * dir-locks / modules-swaps）全是可重建缓存，删掉不影响已装插件本体；
     * 唯一例外 `.cache/pnpm`（PNPM_HOME，全局 bin）必须排除。
     *
     * 清理两级递进：
     * 1. 直接删（普通死锁文件场景，最干净）；
     * 2. 删不动（Root 残留属主 + 000，里面的 .lock 无法 unlink）→
     *    **rename 绕开**：rename 只改父目录条目、不进入目录内部，只要
     *    `.cache` 本身可写（必然）就成功。pnpm 只按固定名
     *    （如 `pnpm-store-operation-locks-<uid>`）找锁，改名后等于无锁
     *    状态，下次安装自动重建。改名残留的 `.broken-*` 由 pnpm 侧无感，
     *    占用极小（锁目录只有两个空 .lock 文件）。
     */
    private fun healPnpmStore(ctx: Context): Boolean {
        val cacheDir = File(EngineConfig.dshHome(ctx), ".cache")
        fun targets(): List<File> = runCatching {
            cacheDir.listFiles()?.filter {
                it.name.startsWith("pnpm") && it.name != "pnpm"
            }.orEmpty()
        }.getOrDefault(emptyList())

        if (targets().isEmpty()) return true
        targets().forEach { EngineConfig.deleteNoFollow(it) }

        if (targets().isNotEmpty()) {
            // 删不动 = 属主/权限坏（Root 残留 000）。rename 不进入目录内部，
            // 只改 .cache 的目录条目，属主正常即必成功。
            val ts = System.currentTimeMillis()
            targets().forEach { f ->
                val moved = runCatching { f.renameTo(File(cacheDir, ".broken-${f.name}-$ts")) }
                    .getOrDefault(false)
                if (moved) Log.w(TAG, "healPnpmStore: renamed undeletable ${f.name} out of the way")
            }
        }
        return targets().isEmpty()
    }
}

package app.dsh.mobile.engine

import app.dsh.mobile.R

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.nio.file.Files
import java.security.MessageDigest
import java.util.zip.ZipInputStream

/**
 * Node 运行时安装器。
 *
 * 两种包形态（由构建期 MANIFEST 的 `package` 决定）：
 *  - `full`：assets/runtime.zip 随 APK 分发，离线安装；
 *  - `noruntime`：APK 不含运行时，按 MANIFEST 的 `runtime.urls` 下载（强制 SHA-256）。
 *
 * 版本语义（v1.4.20）：
 *  - full 包：包内 runtime 版本比已安装的新 → 本地重装（不下载）；
 *  - noruntime 包：**已装好就复用**，绝不因 App 升级重下运行时；更新走显式云更新。
 *
 * 安装 = 解压到 filesDir/engine + 恢复可执行位。
 * zip 不保存 Unix 权限，因此解压后对 bin/ 下所有文件 chmod 755；
 * targetSdk 28 下 SELinux 允许对 filesDir 内文件 execve，无需 jniLibs 伪装。
 */
class RuntimeInstaller(private val ctx: Context) {

    data class RuntimeInfo(
        val version: String,
        val builtAt: Long,
        val bundled: Boolean,
        val url: String?,
        val urls: List<String>,
        val sha256: String?,
        val size: Long,
        val unpackedBytes: Long,
    )

    data class Manifest(
        val packageName: String,
        val abi: String,
        val runtime: RuntimeInfo,
        val indexUrl: String?,
    )

    private data class Installed(
        val version: String,
        val builtAt: Long,
        val source: String,
    )

    private val root get() = EngineConfig.engineRoot(ctx)
    private val stampFile get() = File(root, ".runtime-version")
    private val metaFile get() = File(root, ".runtime.json")

    fun readManifest(): Manifest {
        val raw = ctx.assets.open("runtime/MANIFEST.json").bufferedReader().use { it.readText() }
        val obj = JSONObject(raw)
        val rt = obj.optJSONObject("runtime")
        val legacy = rt == null
        val urls = mutableListOf<String>()
        if (rt != null) {
            rt.optJSONArray("urls")?.let { arr ->
                for (i in 0 until arr.length()) {
                    val u = arr.optString(i)
                    if (u.isNotBlank() && u !in urls) urls.add(u)
                }
            }
            rt.optString("url").takeIf { it.isNotBlank() }?.let { if (it !in urls) urls.add(0, it) }
        } else {
            obj.optString("url").takeIf { it.isNotBlank() }?.let { urls.add(it) }
        }
        val runtime = RuntimeInfo(
            version = if (legacy) obj.optString("version", "unknown") else rt!!.optString("version", "unknown"),
            builtAt = if (legacy) 0L else rt!!.optLong("builtAt", 0L),
            bundled = if (legacy) hasAsset("runtime.zip") else rt!!.optBoolean("bundled", false),
            url = if (legacy) obj.optString("url").takeIf { it.isNotBlank() } else rt!!.optString("url").takeIf { it.isNotBlank() },
            urls = urls,
            sha256 = (if (legacy) obj.optString("sha256") else rt!!.optString("sha256")).takeIf { it.isNotBlank() },
            size = if (legacy) 0L else rt!!.optLong("size", 0L),
            unpackedBytes = if (legacy) 0L else rt!!.optLong("unpackedBytes", 0L),
        )
        val packageName = obj.optString("package").ifBlank { if (runtime.bundled) "full" else "noruntime" }
        val indexUrl = obj.optJSONObject("updates")?.optString("indexUrl")?.takeIf { it.isNotBlank() }
        return Manifest(packageName, obj.optString("abi"), runtime, indexUrl)
    }

    /** 确保运行时就绪；已安装且关键资产完整时按包形态决定是否复用。
     *  @param onProgress 解压进度 0f..1f（仅解压阶段有值；频繁调用方自行节流）
     *  @param onDetail 解压的文件数/字节数明细（v1.4.8：启动遮罩显示"已加载 N/M 个文件"）
     *
     *  @return true = 复用了已安装的运行时（本次没有解压）；false = 执行了解压/下载 */
    fun ensureInstalled(
        onProgress: (Float) -> Unit = {},
        onDetail: (BootTrace.Install) -> Unit = {},
    ): Boolean {
        val manifest = readManifest()
        val complete = EngineConfig.nodeBin(ctx).exists() && isRootComplete()
        if (complete) {
            val installed = readInstalled()
            val reuse = when {
                // 简单包：只要运行时完整就复用；运行时更新只能显式触发。
                manifest.packageName == "noruntime" -> true
                // 完整包：包内版本更新时本地重装（无下载）。
                !manifest.runtime.bundled -> true
                manifest.runtime.version.isBlank() || manifest.runtime.version == "unknown" -> true
                installed != null -> installed.version == manifest.runtime.version
                else -> runCatching { stampFile.readText().trim() == manifest.runtime.version }
                    .getOrDefault(false)
            }
            if (reuse) {
                if (installed == null) writeStamp(manifest.runtime, bundled = manifest.runtime.bundled)
                Log.i(TAG, "runtime ${manifest.runtime.version} already installed (${manifest.packageName})")
                return true
            }
            Log.i(
                TAG,
                "runtime upgrade in package: installed=${installed?.version ?: "?"} " +
                    "bundled=${manifest.runtime.version}; reinstalling locally",
            )
        } else {
            Log.w(TAG, "runtime install incomplete (missing assets); installing")
        }
        install(manifest, onProgress, onDetail)
        return false
    }

    /** 读安装元数据（.runtime.json），旧安装回退到纯文本版戳。 */
    private fun readInstalled(): Installed? = runCatching {
        if (metaFile.isFile) {
            val obj = JSONObject(metaFile.readText())
            return@runCatching Installed(
                version = obj.optString("version"),
                builtAt = obj.optLong("builtAt", 0L),
                source = obj.optString("source"),
            )
        }
        if (stampFile.isFile) {
            return@runCatching Installed(stampFile.readText().trim(), 0L, "legacy")
        }
        null
    }.getOrElse { e ->
        Log.w(TAG, "runtime metadata unreadable (${e.javaClass.simpleName}: ${e.message})")
        null
    }

    private fun hasAsset(path: String): Boolean = runCatching {
        ctx.assets.open(path).close()
        true
    }.getOrDefault(false)

    /**
     * 完整性探针：校验最容易被部分解压吞掉的【引擎入口 JS】与【关键动态库】存在。
     * 只查「必须存在」的锚点文件，避免与运行时裁剪的解耦（不校验具体数量）。
     * @return true 表示本次安装是完整的
     */
    private fun isRootComplete(): Boolean {
        // 1) 引擎入口 bin.js（MODULE_NOT_FOUND 的直接案发现场）
        if (!EngineConfig.dshEntry(ctx).isFile) return false
        // 2) bash 依赖闭环：readline SONAME 别名（m1.5 事故）
        val lib = File(root, "lib")
        if (!File(lib, "libreadline.so.8").isFile) return false
        // 3) node 本体可执行位（安装器 restoreExecBits 之后应为 true）
        if (!EngineConfig.nodeBin(ctx).canExecute()) return false
        // 4) @deepseek-ai 作用域下锚点文件存在（空壳=部分解压）
        //
        // ⚠️ v1.4.4 性能修复（用户实测手表启动 12s → 40s）：
        // 此前用 `walkTopDown().filter{isFile}.count() < 100` 判「不是空壳」。
        // 引擎 0.2.1 改成逐包嵌套依赖后，`@deepseek-ai` 下文件从 2,093 涨到
        // **33,620**，而这段代码**每次启动**都要把整棵树走一遍。Android 上
        // stat/readdir 很贵（实测 5k 目录需 3.2s），阈值只有 100 却付了 3 万文件的代价 ——
        // 这是「每次启动变慢」最确定的单一来源。
        //
        // 改为固定锚点抽样：覆盖入口包、核心框架、内置 profile 层与前端 bundle，
        // 任一处缺失即判不完整（宁可多装一次，也不让坏安装走快路径）。
        val dshAi = File(root, "lib/node_modules/@deepseek-ai")
        val anchors = listOf(
            "dsh/lib/bin.js",                     // 引擎入口
            "dsh/package.json",                   // 包元数据
            "cordis/lib/index.js",                // 核心框架（所有插件依赖）
            "dsh-base/cordis.patch.yml",          // 内置 profile 层
            "dsh-web-app/cordis.patch.yml",       // web profile 层
            "dsh-client-ui-chat/lib/client.js",   // 浏览器端主 bundle
        )
        for (rel in anchors) {
            if (!File(dshAi, rel).isFile) {
                Log.w(TAG, "runtime incomplete: missing anchor @deepseek-ai/$rel")
                return false
            }
        }
        // 5) **架构必须匹配**（v1.3.3，issue #23）
        //
        // 前四项都通过、但 node 是另一个 CPU 架构的二进制时，会发生最坏的情况：
        //   · 文件在、可执行位在 → 探针判「安装完整」→ 写入版本戳 → 永远走快路径
        //   · 真正的失败发生在 execve：linker 直接拒绝跨架构 ELF
        //     （`EXEC format error`，exit=1，Android 没有 binfmt/qemu 用户态模拟）
        //   · 于是每轮启动都是「已安装 → 启动 → 立刻死」的确定循环，**永不自我修复**
        //     只能清数据/重装 —— 对用户就是「装完就是坏的」。
        // 所以架构是完整性的一部分，不是附加检查。
        val want = expectedElfMachine()
        if (want > 0) {
            val got = elfMachine(EngineConfig.nodeBin(ctx))
            if (got != want) {
                Log.e(TAG, "runtime node architecture mismatch: e_machine=$got, device expects $want")
                return false
            }
        }
        return true
    }

    /** ELF e_machine 取值（System V ABI） */
    private val EM_ARM = 40
    private val EM_X86_64 = 62
    private val EM_AARCH64 = 183

    /** 本机主 ABI 对应的 e_machine；无法判定返回 -1（此时跳过校验，不误伤） */
    private fun expectedElfMachine(): Int {
        for (abi in android.os.Build.SUPPORTED_ABIS) {
            when (abi) {
                "arm64-v8a" -> return EM_AARCH64
                "x86_64" -> return EM_X86_64
                "armeabi-v7a", "armeabi" -> return EM_ARM
            }
        }
        return -1
    }

    /** 读 ELF 头的 e_machine；读不到 / 不是 ELF 返回 -1 */
    private fun elfMachine(file: File): Int = runCatching {
        file.inputStream().use { elfMachine(it) }
    }.getOrDefault(-1)

    /** 从流里读 ELF e_machine（只读头 20 字节，不整体载入） */
    private fun elfMachine(ins: java.io.InputStream): Int = runCatching {
        val head = ByteArray(20)
        var read = 0
        while (read < head.size) {
            val n = ins.read(head, read, head.size - read)
            if (n <= 0) return -1
            read += n
        }
        // 0x7F 'E' 'L' 'F'
        if (head[0] != 0x7F.toByte() || head[1] != 'E'.code.toByte() ||
            head[2] != 'L'.code.toByte() || head[3] != 'F'.code.toByte()
        ) return -1
        // e_machine @ 18，little-endian（Android 全部小端）
        (head[18].toInt() and 0xFF) or ((head[19].toInt() and 0xFF) shl 8)
    }.getOrDefault(-1)

    /** 解压前校验源 runtime.zip 里的 bin/node 架构，不匹配就抛确定性错误 */
    private fun assertAssetArch(zip: File) {
        val want = expectedElfMachine()
        if (want <= 0) return
        val got = runCatching {
            java.util.zip.ZipFile(zip).use { zf ->
                val entry = zf.getEntry("bin/node") ?: return@use -1
                zf.getInputStream(entry).use { elfMachine(it) }
            }
        }.getOrDefault(-1)
        if (got != want) {
            // ⚠️ 不能只是返回 false 让它重装：APK 内的包就是错的，重装 100 次也一样，
            // 反而把用户拖进「重装→启动→再死」的循环。这里抛确定性异常，
            // 由监督器转成明确的 Failed 状态（见 EngineArchMismatchException 的消费点）。
            throw EngineArchMismatchException(
                "runtime node architecture mismatch: bundled e_machine=$got, device expects $want",
            )
        }
    }

    /**
     * 把 APK 内置的 runtime.zip 拷到 cacheDir，并按字节上报进度（v1.4.8）。
     *
     * 拷贝 240MB 在低端设备上可占 30-60 秒，是"解压"阶段里最长的一段。
     * 不报进度的话，遮罩在整段时间里只能显示一句静态文案。
     *
     * 用 [BootTrace.Install] 复用同一个数据模型：文件数填 0（这一步没有文件概念），
     * 字节数是确定值，遮罩按 `totalFiles == 0` 走纯字节展示。
     */
    private fun copyAssetWithProgress(
        dest: File,
        onDetail: (BootTrace.Install) -> Unit,
    ) {
        val total = runCatching {
            ctx.assets.openFd("runtime.zip").use { it.length }
        }.getOrNull() ?: -1L
        var done = 0L
        var lastAt = 0L
        ctx.assets.open("runtime.zip").use { input ->
            dest.outputStream().use { out ->
                val buf = ByteArray(1 shl 20)   // 1MB：240 次回调级别的粒度
                while (true) {
                    val n = input.read(buf)
                    if (n <= 0) break
                    out.write(buf, 0, n)
                    done += n
                    val now = System.currentTimeMillis()
                    if (now - lastAt >= 250L) {
                        lastAt = now
                        runCatching {
                            onDetail(
                                BootTrace.Install(
                                    doneFiles = 0,
                                    totalFiles = 0,
                                    doneBytes = done,
                                    totalBytes = if (total > 0) total else 0,
                                ),
                            )
                        }
                    }
                }
            }
        }
        // 收尾：拷贝完成，进度落到 100%
        runCatching {
            onDetail(
                BootTrace.Install(
                    doneFiles = 0,
                    totalFiles = 0,
                    doneBytes = done,
                    totalBytes = if (total > 0) total else done,
                ),
            )
        }
    }

    private fun install(
        manifest: Manifest,
        onProgress: (Float) -> Unit,
        onDetail: (BootTrace.Install) -> Unit = {},
    ) {
        val info = manifest.runtime
        Log.i(TAG, "installing runtime ${info.version} (${manifest.packageName})")
        installing = true
        try {
            val assetZip = File(ctx.cacheDir, "runtime.zip")
            assetZip.delete()
            // 【v1.2.97】空间预检（用户邮件反馈：覆盖升级后引擎反复崩溃重启）。
            // 覆盖升级 = 旧 runtime 还在盘上 + zip 缓存 + 新解压峰值同卷并存。
            fun mb(v: Long) = v / (1L shl 20)
            fun requireFree(needMb: Long) {
                val usable = root.usableSpace
                check(usable >= needMb * (1L shl 20)) {
                    ctx.getString(R.string.error_runtime_no_space, needMb, mb(usable))
                }
            }

            val bundled = info.bundled && hasAsset("runtime.zip")
            if (bundled) {
                requireFree(600)   // 旧 runtime + zip 缓存 + 新解压并存
                // v1.4.8：assets → cache 的拷贝本身就要几十秒，按字节上报进度
                copyAssetWithProgress(assetZip, onDetail)
                requireFree(assetZip.length() / (1L shl 20) + 400)
            } else {
                val url = info.urls.firstOrNull() ?: info.url
                    ?: throw IllegalStateException(ctx.getString(R.string.error_runtime_no_source))
                val needMb = if (info.unpackedBytes > 0) mb(info.unpackedBytes) + 300 else 800
                requireFree(needMb)
                val expected = info.sha256?.takeIf { it.isNotBlank() }
                    ?: throw IllegalStateException(
                        "Runtime download has no SHA-256 pin: $url " +
                            "(edge/preview builds resolve it via runtime-index.json)",
                    )
                Log.i(TAG, "downloading runtime ${info.version} from $url")
                downloadTo(url, assetZip)
                val actual = sha256(assetZip)
                check(actual.equals(expected, ignoreCase = true)) {
                    "Runtime checksum mismatch: expected=$expected actual=$actual"
                }
                if (info.size > 0) {
                    check(assetZip.length() == info.size) {
                        "Runtime size mismatch: expected=${info.size} actual=${assetZip.length()}"
                    }
                }
            }

            // v1.3.3（issue #23）：解压前断言架构。必须在**删除旧 runtime 之前**做 ——
            // 否则发现架构不对时旧环境已经被拆了，用户从「启动失败」退化成「什么都没了」。
            assertAssetArch(assetZip)

            // v1.2.21 事故修复：原 root.deleteRecursively() 会把 engine/ 整个删光，
            // extensions/（用户下载的全家扩展）一起陪葬；且删除 70MB 目录耗时较长，
            // 与用户点扩展下载并发 → 刚发布的扩展目录被删到只剩 lib → rename 报
            // 「扩展目录发布失败」。现在按 zip 实际顶层目录（bin/etc/lib/share/usr）
            // 精确替换，extensions/ 等用户资产永不触碰。
            root.mkdirs()
            val topDirs = java.util.zip.ZipFile(assetZip).use { zf ->
                zf.entries().asSequence()
                    .map { it.name.substringBefore('/') }
                    .filter { it.isNotEmpty() }
                    .toSet()
            }
            // ⚠️ v1.3.1：删除旧 runtime 前先确保**删得掉**。
            // Root 引擎（uid 0）在 engine/ 下写过的文件属主是 root，App 删不掉 →
            // deleteRecursively 静默留下残余 → 新文件覆盖写入 EACCES → 每次启动都重装失败
            // （用户报的「异常退出后无法使用，删掉重装才好」）。这里在删除前先走一次
            // 属性自愈（chown + chmod + restorecon，Shizuku/su 通道），失败也不阻断
            // ——只是把「注定失败」变成「大概率成功」。
            runCatching {
                if (Privilege.dshHomeNeedsOwnershipFix(ctx)) {
                    Log.w(TAG, "runtime reinstall: healing file attributes before wipe")
                    Privilege.fixHomeOwnership(ctx)
                }
            }
            topDirs.forEach { top ->
                val victim = File(root, top)
                if (!victim.deleteRecursively() && victim.exists()) {
                    // 删不干净必须留痕：否则只在下一轮 unzip 失败时暴露，原因已丢失
                    Log.w(TAG, "runtime reinstall: could not fully remove ${victim.absolutePath}")
                }
            }

            unzip(assetZip, root, onProgress, onDetail)
            restoreExecBits(root)
            writeStamp(info, bundled)
            assetZip.delete()
            Log.i(TAG, "runtime installed at $root (kept top dirs: ${topDirs.joinToString()})")
        } finally {
            installing = false
        }
    }

    /** 写安装元数据：`.runtime.json`（新） + `.runtime-version`（旧代码/诊断仍读它）。 */
    private fun writeStamp(info: RuntimeInfo, bundled: Boolean) {
        val obj = JSONObject()
            .put("version", info.version)
            .put("builtAt", info.builtAt)
            .put("sha256", info.sha256 ?: "")
            .put("source", if (bundled) "bundled" else "download")
            .put("installedAt", System.currentTimeMillis())
        runCatching { metaFile.writeText(obj.toString()) }
            .onFailure { Log.w(TAG, "cannot write .runtime.json: ${it.message}") }
        runCatching { stampFile.writeText(info.version) }
            .onFailure { Log.w(TAG, "cannot write .runtime-version: ${it.message}") }
    }

    private fun downloadTo(url: String, dest: File) {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 15_000
        conn.readTimeout = 60_000
        conn.instanceFollowRedirects = true
        // getInputStream 隐式触发连接；非 2xx 视为失败
        val code = conn.responseCode
        check(code in 200..299) { "Download failed with HTTP $code: $url" }
        conn.inputStream.use { input ->
            dest.outputStream().use { input.copyTo(it) }
        }
    }

    private fun unzip(
        zip: File,
        target: File,
        onProgress: (Float) -> Unit,
        onDetail: (BootTrace.Install) -> Unit = {},
    ) {
        // 预扫 central directory 拿总未压缩字节（ZipInputStream 流式读时 size 可能为 -1，
        // ZipFile 走 central directory 是精确的）→ 真实确定性进度而非假转圈
        var total = 0L
        // 文件数双口径（v1.4.8）：字节数在解压小文件时几乎不动，用户看到进度条
        // 长时间停在同一个百分比；"已加载 N/M 个文件"更直观且始终在动。
        var totalFiles = 0
        java.util.zip.ZipFile(zip).use { zf ->
            val entries = zf.entries()
            while (entries.hasMoreElements()) {
                val e = entries.nextElement()
                total += e.size
                if (!e.isDirectory) totalFiles++
            }
        }
        var done = 0L
        var doneFiles = 0
        // 明细节流：每 256 个文件或每 4MB 才回调一次，避免两万次状态更新
        var lastDetailAt = 0L
        fun publishDetail(force: Boolean = false) {
            val now = System.currentTimeMillis()
            if (!force && now - lastDetailAt < 250L) return
            lastDetailAt = now
            runCatching {
                onDetail(
                    BootTrace.Install(
                        doneFiles = doneFiles,
                        totalFiles = totalFiles,
                        doneBytes = done,
                        totalBytes = total,
                    ),
                )
            }
        }
        // 别名去重（v1.2.98）：Termux 的 SONAME 别名（libicu.so.78.3 → libicu.so.78
        // → libicu.so）在打包时若各自存一份，仅 ICU 一家就浪费 ~95MB（实测全库 89.4MB）。
        // 打包侧改为「只存一份数据，其余别名条目的 comment 写 LINK:<本体路径>」，
        // 这里解压时**复制成实体文件**还原（linker 不认链接，见 materialiseLink 的说明）。
        //
        // ⚠️ 必须**两阶段**：zip 里别名条目可能排在本体之前（实测 libz.so.1 排在
        // libz.so 之前），若边解压边建链，链接时本体还不存在 → 变成 0 字节空文件
        // （正是「CANNOT LINK ... libz.so.1 not found」那类故障的成因）。
        // 所以先落全部本体，再统一建链接 —— 与 ExtensionManager 的 deb 解包同一套路。
        val linkTargets = readLinkTargets(zip)
        if (linkTargets.isNotEmpty()) {
            Log.i(TAG, "unzip: ${linkTargets.size} deduplicated alias entries (copied)")
        }
        ZipInputStream(zip.inputStream().buffered()).use { zis ->
            while (true) {
                val entry = zis.nextEntry ?: break
                val out = File(target, entry.name).canonicalFile
                // 防 zip-slip：解压目标必须落在 engineRoot 内
                check(out.path.startsWith(target.canonicalPath)) { "zip-slip: ${entry.name}" }
                if (entry.isDirectory) {
                    out.mkdirs()
                } else if (linkTargets.containsKey(entry.name)) {
                    // 别名条目：zip 里数据为空，跳过写入，阶段 2 统一建链
                    out.parentFile?.mkdirs()
                    doneFiles++
                    publishDetail()
                } else {
                    out.parentFile?.mkdirs()
                    out.outputStream().use { done += zis.copyTo(it) }
                    doneFiles++
                    if (total > 0) onProgress((done.toDouble() / total).toFloat().coerceIn(0f, 1f))
                    publishDetail()
                }
                zis.closeEntry()
            }
        }
        // 阶段 2：本体已全部落地，建硬链接（失败自动回退复制）
        linkTargets.forEach { (alias, linkTo) ->
            materialiseLink(target, linkTo, File(target, alias).canonicalFile)
        }
        // 收尾强制发一次：进度条要落到 100%、文件数要落到 N/N
        publishDetail(force = true)
    }

    /** 别名条目表：条目 comment 形如 `LINK:lib/libicu.so.78.3` → 该条目只需建硬链接 */
    private fun readLinkTargets(zip: File): Map<String, String> {
        val map = HashMap<String, String>()
        java.util.zip.ZipFile(zip).use { zf ->
            val it = zf.entries()
            while (it.hasMoreElements()) {
                val e = it.nextElement()
                val c = e.comment ?: continue
                if (c.startsWith(LINK_PREFIX)) map[e.name] = c.removePrefix(LINK_PREFIX)
            }
        }
        return map
    }

    /**
     * 还原别名（v1.2.98/v1.2.99 定稿）：**复制成实体文件**。
     *
     * ## 为什么最终只能复制（三轮实测的结论）
     * 打包侧把内容相同的 SONAME 别名去重（zip 里只存一份数据，省 33MB APK），
     * 解压侧必须把别名还原成**真实文件**，因为 Android 的 linker 在 app 域
     * **既不认硬链接也不认符号链接**：
     *
     * - 硬链接：SELinux 直接拒绝
     *   `avc: denied { link } ... scontext=u:r:untrusted_app_27 tclass=file`
     * - 符号链接：能创建，但 **linker 不跟随** →
     *   `CANNOT LINK EXECUTABLE ".../bin/node": library "libz.so.1" not found`
     *   （`libz.so.1 -> libz.so` 明明存在却找不到，引擎完全起不来）
     *
     * 这也解释了 collect-termux-runtime.sh 里那句注释的原意 ——
     * 「Android SELinux 禁 symlink/link()，必须 cp 出普通文件别名」。
     *
     * ## 结果
     * APK 体积省下来了（156→124MB）；解压后磁盘占用与优化前相同（~582MB）。
     * 体积与磁盘不可兼得，优先保 APK（下载/分享成本更直观），磁盘靠用户清理。
     */
    private fun materialiseLink(root: File, linkTo: String, dest: File) {
        val src = File(root, linkTo).canonicalFile
        if (!src.isFile) {
            Log.w(TAG, "alias source missing: $linkTo (for ${dest.name})")
            return
        }
        runCatching {
            if (dest.exists()) dest.delete()
            src.copyTo(dest, overwrite = true)
        }.onFailure { Log.w(TAG, "alias copy failed for ${dest.name}: ${it.message}") }
    }

    /**
     * 恢复可执行位（zip 不保存 Unix 权限，解压后一律是 0644）。
     *
     * ## 为什么不能只扫 bin/ 和 usr/bin/（v1.2.100 修）
     * AI 自查发现 `grep` / `glob` 工具报
     * 「ripgrep provider failure」，但 bash 里 `rg` 正常 —— 因为工具走的**不是**
     * PATH 里的 `engine/bin/rg`，而是 npm 包内的副本：
     *
     *     lib/node_modules/@vscode/ripgrep-android-arm64/bin/rg   ← 权限 0600，spawn 时 EACCES
     *     engine/bin/rg                                           ← 正常（旧逻辑扫到了）
     *
     * `dsh-tool-fs-search` 的 `resolveRgPath()` 从 `@vscode/ripgrep` 解析路径，
     * 拿到的是前者。旧实现只扫两个固定目录 → 漏掉 node_modules 里的可执行文件。
     *
     * ## 现在的做法
     * ① 固定目录（bin / usr/bin）全量置可执行 —— 保持原有语义
     * ② 全树扫描 node_modules 下的 bin 目录与已知可执行名 —— 覆盖包内副本
     * ③ 只对**确实是 ELF 或脚本**的文件动手（读前 4 字节），避免给 .md/.json 加 x 位
     */
    private fun restoreExecBits(root: File) {
        fun grant(f: File) {
            runCatching {
                f.setExecutable(true, false)
                f.setReadable(true, false)
            }
        }
        // ① 固定目录
        listOf("bin", "usr/bin").forEach { dir ->
            File(root, dir).takeIf { it.isDirectory }?.listFiles()?.forEach { grant(it) }
        }
        // ② node_modules 下的 bin/ 目录（ripgrep / esbuild / 各类 CLI 副本都在这）
        val nm = File(root, "lib/node_modules")
        if (!nm.isDirectory) return
        nm.walkTopDown()
            .maxDepth(6)
            .filter { it.isFile }
            .filter { f ->
                val p = f.invariantSeparatorsPath
                // 只处理 bin/ 与 .bin/ 目录内的，或已知需要执行位的名字。
                // ⚠️ v1.4.6（审查）：`/bin/` 匹配不到 `node_modules/.bin/xxx`
                //（那是 `/.bin/`，中间没有 `/bin/` 子串）。当前 runtime 里有 12 个
                // `.bin` 条目（.bin/dsh、.bin/cordis、.bin/semver…），全部是
                // `#!/usr/bin/env node` 脚本 —— 一个都没被置上可执行位，任何直接
                // exec `.bin/xxx` 的路径（npm/pnpm 的 PATH 注入、工具链 shim）
                // 都会 EACCES，表现为「某个工具偶发不可用」。
                p.contains("/bin/") || p.contains("/.bin/") || f.name in EXECUTABLE_NAMES
            }
            .forEach { f ->
                if (isElfOrScript(f)) grant(f)
            }
    }

    /** 前 4 字节是 ELF 魔数，或首行以 #! 开头（脚本） */
    private fun isElfOrScript(f: File): Boolean = runCatching {
        f.inputStream().use { ins ->
            val head = ByteArray(4)
            if (ins.read(head) < 2) return@use false
            val isElf = head[0] == 0x7F.toByte() && head[1] == 'E'.code.toByte() &&
                head[2] == 'L'.code.toByte() && head[3] == 'F'.code.toByte()
            isElf || (head[0] == '#'.code.toByte() && head[1] == '!'.code.toByte())
        }
    }.getOrDefault(false)

    companion object {
        /** runtime 装配进行中：ExtensionManager 拒绝在此窗口安装扩展（防互删） */
        @Volatile
        var installing: Boolean = false
            private set

        private const val TAG = "RuntimeInstaller"

        /**
         * 别名条目标记（v1.2.98）：打包侧把重复内容的 so 只存一份，其余条目在 zip
         * comment 里写 `LINK:<本体相对路径>`；解压时据此建硬链接而非写重复数据。
         */
        const val LINK_PREFIX = "LINK:"

        /**
         * 除 bin/ 目录外仍需可执行位的文件名（v1.2.100）。
         * ripgrep 的包内副本在 `@vscode/ripgrep-<arch>/bin/rg`（已被 /bin/ 规则覆盖），
         * 这里列的是可能放在其他位置的常见可执行文件。
         */
        private val EXECUTABLE_NAMES = setOf(
            "rg", "esbuild", "node", "sharp", "swc", "dprint", "biome",
        )

        /** @deepseek-ai 作用域下「完整安装」至少应存在的文件数（m1.12 空壳事故阈值） */
        private const val MIN_DSH_AI_FILES = 100

        fun sha256(file: File): String {
            val md = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buf = ByteArray(1 shl 16)
                while (true) {
                    val n = input.read(buf)
                    if (n <= 0) break
                    md.update(buf, 0, n)
                }
            }
            return md.digest().joinToString("") { "%02x".format(it) }
        }
    }
}

/**
 * 随包 runtime 的 CPU 架构与本机不符（v1.3.3，issue #23）。
 *
 * 这是**确定性**故障：APK 里带的 `bin/node` 就是另一个架构的 ELF，重装多少次都一样。
 * 所以它必须与「解压失败 / 空间不足」这类可重试错误区分开 —— 监督器收到它应直接
 * 进入 Failed 并给出明确文案，而不是继续指数退避重试把用户拖在「装完就是坏的」循环里。
 */
class EngineArchMismatchException(message: String) : Exception(message)

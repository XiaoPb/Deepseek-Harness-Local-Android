package app.dsh.mobile.engine

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File

/**
 * 内置 SSH 远程工作区插件（@xiaopb/dsh-hardssh）安装器。
 *
 * ## 为什么需要独立安装器
 * v1.4.20 起插件不再塞进 `runtime.zip`：运行时可单独更新/重装，而重装会删掉
 * `engine/lib/`（含 node_modules）。插件必须能在 runtime 安装之后**自动补装**，
 * 否则云端运行时（不带插件）一更新，SSH 能力就静默消失。
 *
 * ## 数据来源
 * APK 的 `assets/hardssh/` 目录（构建期由 `scripts/pack-hardssh.sh` 从上游
 * Release tgz 组装，含 `node_modules/{ssh2,ws}`）。没有该目录的旧包直接跳过，
 * 不影响引擎启动。
 *
 * ## 幂等与失败降级
 * - 版本戳 + 目标文件都存在才跳过；
 * - 先复制到临时目录并校验，再整体换名，避免半装；
 * - 任何异常只记日志并返回 null：SSH 不可用，但引擎照常启动。
 */
class HardsshInstaller(private val ctx: Context) {

    data class BundleInfo(val version: String, val bundleSha256: String?)

    /** @return 已就绪的插件版本；APK 未内置或安装失败返回 null */
    fun ensureInstalled(): String? {
        val bundle = readBundle() ?: run {
            Log.i(TAG, "no bundled hardssh assets (older APK); skip")
            return null
        }
        val dest = EngineConfig.sshPluginDir(ctx)
        if (isComplete(dest) && readStampVersion() == bundle.version) {
            Log.i(TAG, "bundled ssh plugin ${bundle.version} already installed")
            return bundle.version
        }
        return install(bundle, dest)
    }

    private fun install(bundle: BundleInfo, dest: File): String? = runCatching {
        val modules = dest.parentFile ?: error("no parent for ${dest.absolutePath}")
        modules.mkdirs()
        val tmp = File(modules, ".hardssh-tmp")
        tmp.deleteRecursively()
        val copied = copyAssetDir(ASSET_ROOT, tmp)
        check(copied > 0) { "assets/$ASSET_ROOT is empty" }
        if (!isComplete(tmp)) {
            tmp.deleteRecursively()
            error("copied bundle is incomplete (${tmp.absolutePath})")
        }

        // 校验通过后再替换：失败时旧插件仍在原位。
        if (dest.exists() && !dest.deleteRecursively()) {
            tmp.deleteRecursively()
            error("cannot remove old bundle at ${dest.absolutePath}")
        }
        if (!tmp.renameTo(dest)) {
            // 极少数文件系统不允许目录 rename：退化为逐文件复制。
            tmp.copyRecursively(dest, overwrite = true)
            tmp.deleteRecursively()
        }
        check(isComplete(dest)) { "installed bundle incomplete at ${dest.absolutePath}" }

        writeStamp(bundle)
        Log.i(TAG, "installed bundled ssh plugin ${bundle.version} -> ${dest.absolutePath}")
        bundle.version
    }.onFailure {
        Log.w(TAG, "bundled ssh plugin install failed: ${it.javaClass.simpleName}: ${it.message}")
    }.getOrNull()

    /** 读取 assets/hardssh/hardssh-bundle.json；旧包没有该目录时返回 null。 */
    private fun readBundle(): BundleInfo? = runCatching {
        val raw = ctx.assets.open("$ASSET_ROOT/hardssh-bundle.json")
            .bufferedReader().use { it.readText() }
        val obj = JSONObject(raw)
        val version = obj.optString("version")
        if (version.isBlank()) return@runCatching null
        BundleInfo(version, obj.optString("bundleSha256").takeIf { it.isNotBlank() })
    }.getOrElse {
        if (it is java.io.FileNotFoundException) null
        else {
            Log.w(TAG, "cannot read bundled hardssh metadata: ${it.message}")
            null
        }
    }

    /** 必需文件齐全（入口、patch 层、两个运行期依赖）。 */
    private fun isComplete(root: File): Boolean =
        File(root, "lib/index.js").isFile &&
            File(root, "cordis.patch.yml").isFile &&
            File(root, "node_modules/ssh2/package.json").isFile &&
            File(root, "node_modules/ws/package.json").isFile

    private fun stampFile(): File = File(EngineConfig.engineRoot(ctx), ".hardssh.json")

    private fun readStampVersion(): String? = runCatching {
        val f = stampFile()
        if (!f.isFile) return@runCatching null
        JSONObject(f.readText()).optString("version").takeIf { it.isNotBlank() }
    }.getOrNull()

    private fun writeStamp(bundle: BundleInfo) {
        val obj = JSONObject()
            .put("version", bundle.version)
            .put("bundleSha256", bundle.bundleSha256 ?: "")
            .put("installedAt", System.currentTimeMillis())
        stampFile().writeText(obj.toString())
    }

    /**
     * 递归把 assets 子目录复制到 [dest]。返回写入的文件数。
     *
     * `AssetManager.list()` 对文件返回空数组、对目录返回子项；空目录不会被
     * 运行时使用，因此这里把「空数组」一律当文件处理是安全的。
     */
    private fun copyAssetDir(assetPath: String, dest: File): Int {
        val children = ctx.assets.list(assetPath) ?: emptyArray()
        if (children.isEmpty()) {
            dest.parentFile?.mkdirs()
            ctx.assets.open(assetPath).use { input ->
                dest.outputStream().use { out -> input.copyTo(out) }
            }
            return 1
        }
        dest.mkdirs()
        var files = 0
        for (name in children) {
            files += copyAssetDir("$assetPath/$name", File(dest, name))
        }
        return files
    }

    companion object {
        private const val TAG = "HardsshInstaller"

        /** 与 CI/构建脚本约定的 assets 目录（见 scripts/pack-hardssh.sh）。 */
        private const val ASSET_ROOT = "hardssh"
    }
}

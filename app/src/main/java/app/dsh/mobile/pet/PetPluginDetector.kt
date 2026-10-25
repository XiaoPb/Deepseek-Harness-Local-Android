package app.dsh.mobile.pet

import android.content.Context
import app.dsh.mobile.engine.EngineConfig
import org.json.JSONObject
import java.io.File

/**
 * 只读探测 web profile 里有没有兼容的桥插件。
 *
 * 不修改任何 profile 文件、不执行 pnpm、不依赖 dsh 进程存活。
 * 判定口径：
 *   - bridgeInstalled：package.json dependencies 里有 dsh-pet-bridge，或 node_modules 里能看见；
 *   - bridgeEnabled：dsh.profile.bundles 里真的有它（装了但没进 bundles 时引擎不会加载）；
 *   - webPetInstalled：dsh-pet（网页桌宠）是否装了，用来给用户区分提示。
 */
object PetPluginDetector {

    const val BRIDGE_PKG = "dsh-pet-bridge"
    const val WEB_PET_PKG = "dsh-pet"

    data class Snapshot(
        val profileExists: Boolean = false,
        val bridgeInstalled: Boolean = false,
        val bridgeEnabled: Boolean = false,
        val webPetInstalled: Boolean = false,
    ) {
        val bridgeReady: Boolean get() = bridgeInstalled && bridgeEnabled
    }

    fun detect(ctx: Context): Snapshot = runCatching {
        val profileDir = File(EngineConfig.dshHome(ctx), "profiles/web")
        val manifest = File(profileDir, "package.json")
        if (!manifest.isFile) return Snapshot(profileExists = false)

        val root = JSONObject(manifest.readText())
        val deps = root.optJSONObject("dependencies")
            ?.keys()?.asSequence()?.toSet() ?: emptySet()
        val bundles = root.optJSONObject("dsh")
            ?.optJSONObject("profile")
            ?.optJSONArray("bundles")
            ?.let { arr -> (0 until arr.length()).mapNotNull { arr.optString(it).takeIf { s -> s.isNotBlank() } } }
            ?.toSet()
            ?: emptySet()

        fun installed(pkg: String): Boolean =
            deps.any { it == pkg || it.endsWith("/$pkg") } ||
                File(File(profileDir, "node_modules"), pkg).isDirectory

        fun enabled(pkg: String): Boolean =
            bundles.any { it == pkg || it.endsWith("/$pkg") }

        Snapshot(
            profileExists = true,
            bridgeInstalled = installed(BRIDGE_PKG),
            bridgeEnabled = enabled(BRIDGE_PKG),
            webPetInstalled = installed(WEB_PET_PKG),
        )
    }.getOrElse { Snapshot(profileExists = false) }
}

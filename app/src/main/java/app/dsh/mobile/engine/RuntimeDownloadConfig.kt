package app.dsh.mobile.engine

import android.content.Context
import android.net.Uri
import app.dsh.mobile.DshApp

/**
 * 运行时下载网络配置（v1.4.21）。
 *
 * ## 为什么需要它
 * 运行时 zip 与签名索引都放在 GitHub Releases。国内直连 `github.com` /
 * `objects.githubusercontent.com` 经常超时、被重置或卡在几十 KB/s；原先
 * 虽然 MANIFEST 里带了 gh-proxy 前缀地址，但下载顺序是「直连 → 代理」，
 * 用户每次都要先等一次 20s 连接超时。关于页的索引请求更是直接写死
 * `https://gh-proxy.org/`，用户无法替换成自建镜像。
 *
 * 现在统一由这里读取偏好：
 *  - 默认 `https://gh-proxy.org/`（国内可用）；
 *  - 用户可改成自建/其它前缀代理；
 *  - 留空 = 不额外套代理（直连）。
 *
 * 代理地址是「前缀式」的：`{proxy}/{原始 GitHub URL}`。只对 GitHub 域名
 * 加前缀，避免把本来就指向其它镜像的地址二次包装。
 */
object RuntimeDownloadConfig {

    /** 默认前缀代理；国内网络下比直连 GitHub 稳定得多。 */
    const val DEFAULT_PROXY = "https://gh-proxy.org/"

    /** 与设置页共用 dsh_ui，不新建 SharedPreferences 文件。 */
    private const val KEY_PROXY = "runtime_download_proxy"

    private fun prefs(ctx: Context) =
        ctx.applicationContext.getSharedPreferences(DshApp.PREFS_UI, Context.MODE_PRIVATE)

    /**
     * 当前代理前缀。
     *
     * 从未设置过 → [DEFAULT_PROXY]；
     * 用户显式留空 → 空串（直连）。
     */
    fun proxy(ctx: Context): String {
        val p = prefs(ctx)
        if (!p.contains(KEY_PROXY)) return DEFAULT_PROXY
        return p.getString(KEY_PROXY, "")?.trim().orEmpty()
    }

    /** 是否仍在使用默认值（设置页文案用）。 */
    fun isDefault(ctx: Context): Boolean = !prefs(ctx).contains(KEY_PROXY)

    /**
     * 保存代理。
     * @param value null = 删除偏好，恢复默认；空串 = 直连；其它按 [normalize] 规范化。
     */
    fun setProxy(ctx: Context, value: String?) {
        val editor = prefs(ctx).edit()
        if (value == null) editor.remove(KEY_PROXY) else editor.putString(KEY_PROXY, normalize(value))
        editor.apply()
    }

    /**
     * 规范化用户输入：允许省略 `https://`，去掉末尾斜杠，去除空白。
     * 空串保持为空（直连）。
     */
    fun normalize(raw: String): String {
        val v = raw.trim()
        if (v.isEmpty()) return ""
        val withScheme = when {
            v.startsWith("http://", ignoreCase = true) ||
                v.startsWith("https://", ignoreCase = true) -> v
            else -> "https://$v"
        }
        return withScheme.trimEnd('/')
    }

    /** 空串（直连）或合法的 http(s) 前缀地址。 */
    fun isValid(raw: String): Boolean {
        val v = normalize(raw)
        if (v.isEmpty()) return true
        return runCatching {
            val uri = Uri.parse(v)
            val scheme = uri.scheme.orEmpty()
            (scheme.equals("http", ignoreCase = true) || scheme.equals("https", ignoreCase = true)) &&
                !uri.host.isNullOrBlank()
        }.getOrDefault(false)
    }

    /**
     * 按「代理优先、直连兜底」重排下载地址。
     *
     * - 已经指向同一代理的 URL 直接归入代理组；
     * - 原始 GitHub 地址生成 `{proxy}/{url}` 变体放最前，原地址留作兜底；
     * - 已经是别的前缀代理 / 非 GitHub 地址不重复包装；
     * - [blockedProxies] 用于「用户显式关闭代理」时剔除 MANIFEST/索引里
     *   预先写好的镜像地址（剔除后为空则保留至少一个，避免无源可用）。
     */
    fun orderUrls(
        urls: List<String>,
        proxy: String,
        blockedProxies: List<String> = emptyList(),
    ): List<String> {
        val cleaned = urls.map { it.trim() }.filter { it.isNotBlank() }.distinct()
        val base = proxy.trim().trimEnd('/')
        if (base.isEmpty()) {
            val blocked = blockedProxies
                .map { it.trim().trimEnd('/') }
                .filter { it.isNotEmpty() }
            if (blocked.isEmpty()) return cleaned
            val filtered = cleaned.filterNot { url ->
                blocked.any { p -> url.startsWith("$p/", ignoreCase = true) }
            }
            return filtered.ifEmpty { cleaned }
        }

        val prefix = "$base/"
        val proxied = ArrayList<String>(cleaned.size)
        val rest = ArrayList<String>(cleaned.size)
        for (url in cleaned) {
            when {
                url.startsWith(prefix, ignoreCase = true) -> proxied.add(url)
                isAlreadyProxied(url) -> rest.add(url)
                isProxyable(url) -> {
                    proxied.add(prefix + url)
                    rest.add(url)
                }
                else -> rest.add(url)
            }
        }
        return (proxied + rest).distinct()
    }

    /** gh-proxy 一类前缀代理只接受 GitHub 的原始地址。 */
    private fun isProxyable(url: String): Boolean {
        val u = url.lowercase()
        return u.startsWith("https://github.com/") ||
            u.startsWith("http://github.com/") ||
            u.startsWith("https://raw.githubusercontent.com/") ||
            u.startsWith("https://objects.githubusercontent.com/")
    }

    /**
     * `https://gh-proxy.org/https://github.com/...` 这类已经是前缀代理的地址。
     * 用它避免用户换代理后出现 `新代理/旧代理/https://...` 的双重包装。
     */
    private fun isAlreadyProxied(url: String): Boolean =
        ALREADY_PROXIED.containsMatchIn(url)

    private val ALREADY_PROXIED = Regex("^https?://[^/]+/https?://", RegexOption.IGNORE_CASE)
}

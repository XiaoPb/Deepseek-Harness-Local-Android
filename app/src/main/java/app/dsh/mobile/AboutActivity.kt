package app.dsh.mobile

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.os.Build
import android.os.Bundle
import android.widget.ImageView
import android.widget.TextView
import android.widget.Toast
import app.dsh.mobile.engine.EngineConfig
import app.dsh.mobile.engine.RepoConfig
import app.dsh.mobile.engine.RuntimeIndexClient
import app.dsh.mobile.engine.RuntimeInstaller
import org.json.JSONObject
import java.io.File

/**
 * 关于页（MIUI 风格）：应用标识卡 + 介绍/特性 + 开源地址（点击复制）。
 * v1.4.18：与设置页一致，跟随应用屏幕朝向偏好（不再固定竖屏）。
 */
class AboutActivity : Activity() {

    override fun attachBaseContext(newBase: android.content.Context) {
        super.attachBaseContext(LocaleHelper.wrap(newBase))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        OrientationPrefs.applyTo(this)
        setContentView(R.layout.activity_about)

        findViewById<ImageView>(R.id.btnBack).setOnClickListener { finish() }
        findViewById<TextView>(R.id.txtVersion).text =
            getString(R.string.about_version, versionName())

        // 开源地址：点击复制到剪贴板（WebView 只放行回环，外链交系统浏览器亦可，复制更轻）
        findViewById<android.view.View>(R.id.rowRepo).setOnClickListener {
            val cm = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("dsh-android", getString(R.string.about_repo)))
            Toast.makeText(this, getString(R.string.about_copied), Toast.LENGTH_SHORT).show()
        }

        // QQ 交流群（v1.4.0）：点击复制群号 —— 与开源地址同样的轻交互。
        // 不尝试 deep link 拉起 QQ：QQ 的加群链接格式各版本不一，且未安装时会失败；
        // 复制群号让用户自己搜索是唯一在所有设备上都成立的路径。
        findViewById<android.view.View>(R.id.rowQqGroup).setOnClickListener {
            val cm = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(
                ClipData.newPlainText("qq-group", getString(R.string.about_qq_group_id))
            )
            Toast.makeText(this, getString(R.string.about_qq_group_copied), Toast.LENGTH_SHORT).show()
        }

        // 检查更新（v1.2.77）：查 GitHub Releases 是否有更高版本
        // 网络请求必须离开主线程（否则 ANR）；结果回主线程更新文案
        findViewById<android.view.View>(R.id.rowUpdate).setOnClickListener {
            // 已发现新版本 → 本次点击是"前往下载"
            val target = pendingReleaseUrl
            if (target != null) {
                openUrl(target)
                return@setOnClickListener
            }
            checkForUpdate()
        }

        // 运行时更新（v1.4.20）：与 App 更新解耦；索引必须验签。
        findViewById<android.view.View>(R.id.rowRuntime).setOnClickListener {
            val pending = pendingRuntime
            if (pending != null) installRuntime(pending) else checkRuntime()
        }
    }

    /** 待安装的运行时（检查到更新后由再次点击触发） */
    private var pendingRuntime: RuntimeIndexClient.Entry? = null

    private val runtimeIndexUrl: String get() = RepoConfig.RELEASES_LATEST + "/runtime-index.json"
    private val runtimeProxy: String get() = "https://gh-proxy.org/"

    private fun checkRuntime() {
        val tv = findViewById<TextView>(R.id.txtRuntime)
        pendingRuntime = null
        tv.text = getString(R.string.about_runtime_checking)
        tv.setTextColor(0xFF8A94A3.toInt())
        val abi = deviceAbi()
        val code = currentVersionCode()
        Thread({
            val entry = RuntimeIndexClient.resolve(
                this, runtimeIndexUrl, runtimeProxy, abi, null, code,
            )
            runOnUiThread {
                when {
                    entry == null -> {
                        tv.text = getString(
                            R.string.about_runtime_failed,
                            getString(R.string.about_runtime_no_pin),
                        )
                        tv.setTextColor(0xFF8A94A3.toInt())
                    }
                    entry.version == installedRuntimeVersion() -> {
                        tv.text = getString(R.string.about_runtime_latest, entry.version)
                        tv.setTextColor(0xFF81C995.toInt())
                    }
                    else -> {
                        pendingRuntime = entry
                        tv.text = getString(R.string.about_runtime_available, entry.version)
                        tv.setTextColor(0xFF7DD3FC.toInt())
                    }
                }
            }
        }, "runtime-check").apply { isDaemon = true; start() }
    }

    private fun installRuntime(entry: RuntimeIndexClient.Entry) {
        val tv = findViewById<TextView>(R.id.txtRuntime)
        tv.text = getString(R.string.about_runtime_installing, 0)
        tv.setTextColor(0xFF7DD3FC.toInt())
        pendingRuntime = null
        Thread({
            // 运行中的引擎会持续读 engine/lib；先停引擎再替换运行时，成功后自动重启。
            val app = application as DshApp
            runCatching { app.supervisor.stop(graceMs = 3_500) }
            try {
                RuntimeInstaller(this).installFromIndex(
                    entry = entry,
                    indexUrl = runtimeIndexUrl,
                    proxies = listOf(runtimeProxy),
                    onProgress = { frac ->
                        val pct = (frac * 100).toInt()
                        runOnUiThread {
                            tv.text = getString(R.string.about_runtime_installing, pct)
                        }
                    },
                )
                runOnUiThread {
                    tv.text = getString(R.string.about_runtime_installed)
                    tv.setTextColor(0xFF81C995.toInt())
                }
            } catch (e: Exception) {
                runOnUiThread {
                    tv.text = getString(
                        R.string.about_runtime_failed,
                        e.message ?: e.javaClass.simpleName,
                    )
                    tv.setTextColor(0xFFF87171.toInt())
                }
            } finally {
                runCatching { app.supervisor.restart() }
            }
        }, "runtime-install").apply { isDaemon = true; start() }
    }

    private fun deviceAbi(): String = when (Build.SUPPORTED_ABIS.firstOrNull()) {
        "arm64-v8a" -> "arm64-v8a"
        "x86_64" -> "x86_64"
        else -> Build.SUPPORTED_ABIS.firstOrNull().orEmpty()
    }

    private fun currentVersionCode(): Int = runCatching {
        val info = packageManager.getPackageInfo(packageName, 0)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode.toInt() else info.versionCode
    }.getOrDefault(0)

    private fun installedRuntimeVersion(): String? = runCatching {
        val root = EngineConfig.engineRoot(this)
        val meta = File(root, ".runtime.json")
        if (meta.isFile) {
            JSONObject(meta.readText()).optString("version").takeIf { it.isNotBlank() }
        } else {
            File(root, ".runtime-version").takeIf { it.isFile }?.readText()?.trim()
        }
    }.getOrNull()

    /** 待跳转的 Release 地址（检测到新版本后由点击触发跳转） */
    private var pendingReleaseUrl: String? = null

    /** 检测更新：后台请求 → 主线程回显 */
    private fun checkForUpdate() {
        val tv = findViewById<TextView>(R.id.txtUpdate)
        tv.text = getString(R.string.about_update_checking)
        val current = versionName()
        Thread({
            val r = app.dsh.mobile.engine.UpdateChecker.check(this, current)
            runOnUiThread {
                when {
                    r.hasUpdate -> {
                        pendingReleaseUrl = r.releaseUrl
                        tv.text = getString(R.string.about_update_available, r.latestTag)
                        tv.setTextColor(0xFF7DD3FC.toInt())
                    }
                    r.error.isNotEmpty() -> {
                        tv.text = getString(R.string.about_update_failed, r.error)
                        tv.setTextColor(0xFF8A94A3.toInt())
                    }
                    else -> {
                        tv.text = getString(R.string.about_update_latest)
                        tv.setTextColor(0xFF81C995.toInt())
                    }
                }
            }
        }, "update-check").apply { isDaemon = true; start() }
    }

    /** 用系统浏览器打开外链（本 App 的 WebView 只放行回环地址，外链必须交系统） */
    private fun openUrl(url: String) {
        runCatching {
            startActivity(
                android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))
                    .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        }.onFailure {
            Toast.makeText(this, getString(R.string.about_update_failed, it.message.orEmpty()), Toast.LENGTH_LONG).show()
        }
    }

    /** 从包管理器读取 versionName（与设置页同源） */
    private fun versionName(): String =
        runCatching { packageManager.getPackageInfo(packageName, 0).versionName }
            .getOrNull() ?: "?"
}

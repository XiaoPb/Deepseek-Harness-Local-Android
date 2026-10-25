package app.dsh.mobile

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Typeface
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import app.dsh.mobile.engine.PluginCenter
import app.dsh.mobile.engine.PluginMarket
import app.dsh.mobile.engine.PluginMarket.Compat
import app.dsh.mobile.engine.PluginMarket.Entry

/**
 * 插件中心（v1.4.21 重写）。
 *
 * ## 为什么要重写
 *
 * 旧版（v1.2.117–v1.4.20）只有一个 npm 搜索列表：没有「已安装」视图，看不到
 * 版本/体积/作者，不能排序、不能检查更新、点进去也没有详情——社区反馈「太简单」。
 * 参考开源项目 DSHA（DSH-APP/DSHA）的插件中心形态后重做：
 *
 *  · **双标签**：市场（浏览/搜索/安装）· 已安装（管理/更新/卸载）；
 *  · **富卡片**：「推荐」角标、名称、版本（可升级时显示 `v1 → v2`）、体积、
 *    作者、兼容性分级徽标（纯 JS / 需原生 / 引擎 fork / 未验证）、描述、
 *    以及升级时的高亮操作按钮；
 *  · **排序**：名称 / 最近更新 / 下载量 / 体积；
 *  · **检查更新**：一次性查全部已装插件的最新版本，汇总提示；
 *  · **详情弹窗**：完整描述、仓库、体积、兼容性判断依据（为什么装不了）；
 *  · 输入即搜（300ms 防抖）、下拉刷新按钮、空态与错误态提示。
 *
 * ## 保留的已验证行为（不要回退）
 *  - 装/卸串行化（[PluginCenter] 单线程执行器）；
 *  - **精确版本**安装与升级（pnpm 12 下 `add pkg`/`@latest`/`update` 全部无效，
 *    只有 `add pkg@<精确版本>` 会真正换版本——v1.4.18 实测）；
 *  - 装前原生模块预检 + 风险确认（[NativePluginCheck]）；
 *  - 按钮状态防抖与视图存活检查（预检期间可能已离开页面）。
 */
class PluginStoreActivity : ThemedActivity() {

    /** 与其余页面一致，按应用内语言偏好包装 Context */
    override fun attachBaseContext(newBase: android.content.Context) {
        super.attachBaseContext(LocaleHelper.wrap(newBase))
    }

    private lateinit var container: LinearLayout
    private lateinit var tvSubtitle: TextView
    private lateinit var etSearch: EditText
    private lateinit var btnClear: ImageView
    private lateinit var btnTabMarket: TextView
    private lateinit var btnTabInstalled: TextView
    private lateinit var btnSort: TextView
    private lateinit var btnCheckUpdates: TextView
    private val dp by lazy { resources.displayMetrics.density }

    /** 当前标签：true = 市场，false = 已安装 */
    private var onMarket = true

    /** 市场结果 / 已安装清单（两份数据分开缓存，切标签不重拉） */
    private var marketEntries: List<Entry> = emptyList()
    private var installedEntries: List<Entry> = emptyList()

    /** 已安装实际版本（升级判断的唯一事实来源） */
    private var installedVer: Map<String, String> = emptyMap()

    private var sortMode = PluginMarket.Sort.NAME_ASC
    private var loading = false
    private var lastError: String? = null

    /** 当前显示的排序/筛选状态是否已应用到列表（避免每次重渲染都重排） */
    private val searchHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private val searchRun = Runnable { reload(verbose = false) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        OrientationPrefs.applyTo(this)
        setContentView(R.layout.activity_plugin_store)
        findViewById<MaxWidthLinearLayout>(R.id.pluginStoreBody).maxWidthDp =
            STORE_CONTENT_MAX_WIDTH_DP

        container = findViewById(R.id.listContainer)
        tvSubtitle = findViewById(R.id.tvSubtitle)
        etSearch = findViewById(R.id.etSearch)
        btnTabMarket = findViewById(R.id.btnTabMarket)
        btnTabInstalled = findViewById(R.id.btnTabInstalled)
        btnSort = findViewById(R.id.btnSort)
        btnCheckUpdates = findViewById(R.id.btnCheckUpdates)
        findViewById<ImageView>(R.id.btnBack).setOnClickListener { finish() }

        btnSort.text = getString(sortMode.labelRes)
        btnTabMarket.setOnClickListener { switchTab(true) }
        btnTabInstalled.setOnClickListener { switchTab(false) }
        btnSort.setOnClickListener { showSortDialog() }
        btnCheckUpdates.setOnClickListener { checkUpdates() }

        btnClear = findViewById(R.id.btnClear)
        btnClear.setOnClickListener {
            etSearch.setText("")
            btnClear.visibility = View.GONE
            hideKeyboard()
            reload(verbose = false)
        }
        etSearch.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEARCH) {
                hideKeyboard()
                reload(verbose = false)
            }
            true
        }
        etSearch.addTextChangedListener(object : android.text.TextWatcher {
            override fun afterTextChanged(s: android.text.Editable?) {
                btnClear.visibility = if (s.isNullOrBlank()) View.GONE else View.VISIBLE
                searchHandler.removeCallbacks(searchRun)
                searchHandler.postDelayed(searchRun, 300)
            }
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
        })

        val initialQuery = intent.getStringExtra(EXTRA_QUERY).orEmpty().trim()
        if (initialQuery.isNotBlank()) {
            etSearch.setText(initialQuery)
            etSearch.setSelection(initialQuery.length)
        }
        reload(verbose = true)
    }

    private fun dp(v: Int): Int = (v * dp).toInt()

    private fun hideKeyboard() {
        (getSystemService(INPUT_METHOD_SERVICE) as? InputMethodManager)
            ?.hideSoftInputFromWindow(etSearch.windowToken, 0)
    }

    // ───────────────────────────────────────────────────────────────────
    // 数据加载
    // ───────────────────────────────────────────────────────────────────

    /**
     * 重载当前标签。
     * @param verbose true 时总是重新拉网络（下拉/切标签/首次进入）；
     *                false 时若结果已在内存则只重渲染（输入防抖不能每次都发请求）
     */
    private fun reload(verbose: Boolean) {
        installedVer = runCatching { PluginCenter.installedVersions(this) }.getOrDefault(emptyMap())
        if (onMarket) loadMarket(verbose) else loadInstalled(verbose)
    }

    private fun loadMarket(force: Boolean) {
        val query = etSearch.text.toString().trim()
        if (!force && query.isBlank() && marketEntries.isNotEmpty()) {
            render()
            return
        }
        loading = true
        lastError = null
        showLoadingState()
        PluginMarket.browse(query, installedVer, checkCompat = true) { entries, err ->
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                loading = false
                lastError = err
                marketEntries = entries
                render()
            }
        }
    }

    private fun loadInstalled(force: Boolean) {
        if (!force && installedEntries.isNotEmpty()) {
            render()
            return
        }
        loading = true
        lastError = null
        showLoadingState()
        PluginMarket.installed(this, checkUpdates = true) { entries, err ->
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                loading = false
                lastError = err
                installedEntries = entries
                render()
                reportUpdates(entries)
            }
        }
    }

    private fun showLoadingState() {
        container.removeAllViews()
        tvSubtitle.text = getString(R.string.plugin_searching)
        container.addView(hint(getString(R.string.plugin_searching)))
    }

    private fun switchTab(market: Boolean) {
        if (onMarket == market) return
        onMarket = market
        hideKeyboard()
        etSearch.clearFocus()
        // 标签样式：选中蓝色加粗，未选中灰色
        btnTabMarket.setTextColor(if (market) 0xFF7DD3FC.toInt() else 0xFF5A626E.toInt())
        btnTabMarket.setTypeface(null, if (market) Typeface.BOLD else Typeface.NORMAL)
        btnTabInstalled.setTextColor(if (!market) 0xFF7DD3FC.toInt() else 0xFF5A626E.toInt())
        btnTabInstalled.setTypeface(null, if (!market) Typeface.BOLD else Typeface.NORMAL)
        etSearch.visibility = if (market) View.VISIBLE else View.GONE
        btnCheckUpdates.visibility = if (market) View.GONE else View.VISIBLE
        reload(verbose = true)
        findViewById<View>(R.id.listContainer).post { /* 列表从顶部开始 */ }
    }

    // ───────────────────────────────────────────────────────────────────
    // 渲染
    // ───────────────────────────────────────────────────────────────────

    private fun render() {
        container.removeAllViews()
        val source = if (onMarket) marketEntries else installedEntries
        val filtered = PluginMarket.filter(source, etSearch.text.toString(), onlyInstalled = !onMarket)
        val sorted = PluginMarket.sort(filtered, sortMode)

        tvSubtitle.text = when {
            loading -> getString(R.string.plugin_searching)
            lastError != null && source.isEmpty() -> getString(R.string.plugin_search_fail)
            else -> buildString {
                append(getString(if (onMarket) R.string.plugin_center_sub else R.string.plugin_tab_installed))
                append(" · ")
                append(sorted.size)
            }
        }
        // 失败提示只保留一条：subtitle 已说明搜索失败，列表内不再重复插 hint（实测两条重叠）
        val failed = lastError != null && source.isEmpty()
        if (sorted.isEmpty() && !loading) {
            container.addView(
                hint(
                    when {
                        failed -> getString(R.string.plugin_search_fail)
                        !onMarket -> getString(R.string.plugin_none_installed)
                        etSearch.text.isNotBlank() -> getString(R.string.plugin_search_none)
                        else -> getString(R.string.plugin_empty)
                    }
                )
            )
            return
        }
        // 市场里已安装的排后面（用户更关心可装的），已安装标签按名称排
        val ordered = if (onMarket) sorted.sortedBy { it.isInstalled } else sorted
        ordered.forEach { container.addView(pluginRow(it)) }
    }

    private fun hint(text: String): TextView = TextView(this).apply {
        this.text = text
        setTextColor(0xFF8A94A3.toInt())
        textSize = 14f
        gravity = Gravity.CENTER
        setPadding(0, dp(30), 0, dp(10))
    }

    /** 插件卡片：名称 + 角标 / 元信息行 / 描述 / 兼容性徽标 / 操作按钮 */
    private fun pluginRow(e: Entry): LinearLayout {
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundResource(R.drawable.bg_card)
            setPadding(dp(16), dp(14), dp(16), dp(14))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { bottomMargin = dp(10) }
            isClickable = true
        }

        // ── 第一行：名称 + 「推荐」角标 + 右侧操作按钮 ──
        val headRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val nameCol = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        nameCol.addView(TextView(this).apply {
            text = e.name
            setTextColor(0xFFFFFFFF.toInt())
            textSize = 15f
            setTypeface(null, Typeface.BOLD)
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
        })
        if (e.official) {
            nameCol.addView(TextView(this).apply {
                text = getString(R.string.plugin_official)
                setTextColor(0xFF7DD3FC.toInt())
                textSize = 10f
                setPadding(dp(6), dp(1), dp(6), dp(1))
                setBackgroundResource(R.drawable.bg_icon_chip_soft)
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT,
                ).apply { marginStart = dp(8) }
            })
        }
        headRow.addView(nameCol)

        val btn = actionButton(e)
        headRow.addView(btn)
        card.addView(headRow)

        // ── 第二行：版本 / 体积 / 作者 ──
        e.metaLine().takeIf { it.isNotBlank() }?.let { meta ->
            card.addView(TextView(this).apply {
                text = meta
                setTextColor(if (e.hasUpdate) 0xFFFBBF24.toInt() else 0xFF8A94A3.toInt())
                textSize = 11f
                setPadding(0, dp(4), 0, 0)
            })
        }

        // ── 第三行：描述 ──
        if (e.desc.isNotBlank()) {
            card.addView(TextView(this).apply {
                text = e.desc
                setTextColor(0xFFB8C0CC.toInt())
                textSize = 12f
                maxLines = 2
                ellipsize = android.text.TextUtils.TruncateAt.END
                setPadding(0, dp(6), 0, 0)
            })
        }

        // ── 第四行：兼容性徽标（只在非纯 JS 时显示，避免每行都加噪音）──
        compatBadge(e)?.let { card.addView(it) }

        // 点卡片 = 详情
        card.setOnClickListener { showDetail(e) }
        return card
    }

    private fun compatBadge(e: Entry): TextView? {
        val (label, color) = when (e.compat) {
            Compat.PURE_JS -> return null   // 纯 JS 是常态，不加徽标
            Compat.NEEDS_NATIVE -> getString(R.string.plugin_compat_native) to 0xFFF87171.toInt()
            Compat.ENGINE_FORK -> getString(R.string.plugin_compat_fork) to 0xFFF87171.toInt()
            Compat.UNKNOWN -> getString(R.string.plugin_compat_unknown) to 0xFF8A94A3.toInt()
        }
        return TextView(this).apply {
            text = "⚠ $label"
            setTextColor(color)
            textSize = 11f
            setPadding(0, dp(6), 0, 0)
        }
    }

    /** 右侧按钮：安装 / 升级 / 已安装（可点卸载） */
    private fun actionButton(e: Entry): TextView {
        val btn = TextView(this).apply {
            textSize = 13f
            gravity = Gravity.CENTER
            minWidth = dp(64)
            setPadding(dp(14), dp(6), dp(14), dp(6))
            setBackgroundResource(R.drawable.bg_btn_outline)
            isClickable = true
            isFocusable = true
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { marginStart = dp(12) }
        }
        when {
            !e.isInstalled -> {
                btn.text = getString(R.string.plugin_install)
                btn.setTextColor(0xFF7DD3FC.toInt())
                btn.setOnClickListener {
                    val spec = if (e.version.isNotBlank()) "${e.pkg}@${e.version}" else e.pkg
                    runInstall(spec, btn, e.pkg)
                }
            }
            e.hasUpdate -> {
                // 精确版本升级：pnpm 12 下 add pkg / @latest / update 全部无效（v1.4.18 实测）
                btn.text = getString(R.string.plugin_upgrade)
                btn.setTextColor(0xFFFBBF24.toInt())
                btn.setText(getString(R.string.plugin_upgrade) + " → ${e.version}")
                btn.setOnClickListener {
                    runInstall("${e.pkg}@${e.version}", btn, e.pkg)
                }
            }
            else -> {
                btn.text = getString(R.string.plugin_installed)
                btn.setTextColor(0xFF4ADE80.toInt())
                btn.setOnClickListener { confirmUninstall(e.pkg, btn) }
            }
        }
        return btn
    }

    // ───────────────────────────────────────────────────────────────────
    // 详情
    // ───────────────────────────────────────────────────────────────────

    private fun showDetail(e: Entry) {
        hideKeyboard()
        val body = StringBuilder()
        if (e.desc.isNotBlank()) body.append(e.desc).append("\n\n")
        body.append(getString(R.string.plugin_detail_title)).append(": ").append(e.pkg).append('\n')
        if (e.installedVer != null) {
            body.append("v").append(e.installedVer)
            if (e.hasUpdate) body.append(" → v").append(e.version)
            body.append('\n')
        } else if (e.version.isNotBlank()) {
            body.append("v").append(e.version).append('\n')
        }
        if (e.author.isNotBlank()) body.append(e.author).append('\n')
        if (e.repo.isNotBlank()) body.append(getString(R.string.plugin_detail_repo))
            .append(": ").append(e.repo).append('\n')

        val dialog = AlertDialog.Builder(this)
            .setTitle(e.name)
            .setMessage(body.toString().trim())
            .setPositiveButton(android.R.string.ok, null)
            .setNeutralButton(R.string.plugin_detail_compat, null)
            .create()

        dialog.setOnShowListener {
            // 中性按钮：拉完整 manifest（体积/仓库/全部版本）+ 兼容性判断依据
            dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener {
                dialog.setMessage(getString(R.string.plugin_loading_detail))
                PluginMarket.detail(e.pkg) { full, err ->
                    runOnUiThread {
                        if (isFinishing || isDestroyed) return@runOnUiThread
                        val merged = full ?: e
                        val sb = StringBuilder()
                        sb.append(merged.desc.ifBlank { e.desc }).append("\n\n")
                        sb.append(getString(R.string.plugin_detail_size)).append(": ")
                        sb.append(PluginMarket.humanSize(merged.unpackedSize).ifBlank { "?" }).append('\n')
                        if (merged.repo.isNotBlank()) {
                            sb.append(getString(R.string.plugin_detail_repo)).append(": ")
                                .append(merged.repo).append('\n')
                        }
                        sb.append(getString(R.string.plugin_detail_compat)).append(": ")
                        sb.append(
                            when (merged.compat) {
                                Compat.PURE_JS -> getString(R.string.plugin_compat_pure)
                                Compat.NEEDS_NATIVE -> getString(R.string.plugin_compat_native)
                                Compat.ENGINE_FORK -> getString(R.string.plugin_compat_fork)
                                Compat.UNKNOWN -> getString(R.string.plugin_compat_unknown)
                            }
                        )
                        if (merged.compatReasons.isNotEmpty()) {
                            sb.append('\n').append(getString(R.string.plugin_detail_reasons)).append(":\n")
                            merged.compatReasons.forEach { sb.append("• ").append(it).append('\n') }
                        }
                        if (err != null) sb.append("\n(").append(err).append(')')
                        dialog.setMessage(sb.toString().trim())
                        dialog.getButton(AlertDialog.BUTTON_NEUTRAL).isEnabled = false
                    }
                }
            }
        }
        dialog.show()
    }

    // ───────────────────────────────────────────────────────────────────
    // 排序 / 检查更新
    // ───────────────────────────────────────────────────────────────────

    private fun showSortDialog() {
        val modes = PluginMarket.Sort.entries
        val labels = modes.map { getString(it.labelRes) }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle(R.string.plugin_sort_title)
            .setSingleChoiceItems(labels, modes.indexOf(sortMode)) { d, which ->
                sortMode = modes[which]
                btnSort.text = getString(sortMode.labelRes)
                d.dismiss()
                render()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun checkUpdates() {
        if (loading) return
        loading = true
        loadInstalled(force = true)
        // loadInstalled 里已带 checkUpdates=true，完成后按结果汇总
        tvSubtitle.text = getString(R.string.plugin_searching)
    }

    /** 已安装标签渲染完后调用：汇总可更新数量 */
    private fun reportUpdates(entries: List<Entry>) {
        val n = entries.count { it.hasUpdate }
        android.widget.Toast.makeText(
            this,
            if (n > 0) getString(R.string.plugin_updates_found, n)
            else getString(R.string.plugin_updates_none),
            android.widget.Toast.LENGTH_SHORT,
        ).show()
    }

    // ───────────────────────────────────────────────────────────────────
    // 安装 / 卸载（保留 v1.4.15–v1.4.18 已验证的全部行为）
    // ───────────────────────────────────────────────────────────────────

    private fun runInstall(pkg: String, btn: TextView, basePkg: String) {
        btn.text = getString(R.string.plugin_checking)
        btn.isEnabled = false
        Thread({
            val r = runCatching { app.dsh.mobile.engine.NativePluginCheck.check(pkg) }
                .getOrElse { app.dsh.mobile.engine.NativePluginCheck.Result.Unknown(it.message ?: "check failed") }
            runOnUiThread {
                btn.isEnabled = true
                when (r) {
                    is app.dsh.mobile.engine.NativePluginCheck.Result.PureJs -> doInstall(pkg, btn, basePkg)
                    is app.dsh.mobile.engine.NativePluginCheck.Result.Unknown -> {
                        btn.text = getString(R.string.plugin_install)
                        confirmInstall(
                            pkg, btn, basePkg,
                            title = getString(R.string.plugin_check_unknown_title),
                            message = getString(R.string.plugin_check_unknown_body, r.reason),
                        )
                    }
                    is app.dsh.mobile.engine.NativePluginCheck.Result.Risk -> {
                        btn.text = getString(R.string.plugin_install)
                        confirmInstall(
                            pkg, btn, basePkg,
                            title = getString(R.string.plugin_native_title),
                            message = getString(
                                R.string.plugin_native_body,
                                r.reasons.joinToString("\n• ", prefix = "• "),
                            ),
                        )
                    }
                }
            }
        }, "plugin-precheck").apply { isDaemon = true; start() }
    }

    private fun confirmInstall(
        pkg: String, btn: TextView, basePkg: String, title: String, message: String,
    ) {
        if (isFinishing || isDestroyed) return
        AlertDialog.Builder(this)
            .setTitle(title)
            .setMessage(message)
            .setPositiveButton(R.string.plugin_install_anyway) { _, _ -> doInstall(pkg, btn, basePkg) }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun doInstall(pkg: String, btn: TextView, basePkg: String) {
        if (isFinishing || isDestroyed) return
        if (!btn.isAttachedToWindow) {
            android.util.Log.w("PluginStore", "install of $pkg dropped: row re-rendered")
            return
        }
        btn.text = getString(R.string.plugin_installing)
        btn.isEnabled = false
        btn.setTextColor(0xFF8A94A3.toInt())
        PluginCenter.install(this, pkg) { ok, msg ->
            runOnUiThread {
                if (ok) {
                    btn.text = getString(R.string.plugin_installed)
                    btn.setTextColor(0xFF4ADE80.toInt())
                    btn.isClickable = true
                    btn.isEnabled = true
                    btn.setOnClickListener { confirmUninstall(basePkg, btn) }
                    // 重读真实版本后整页刷新（升级场景下版本号/按钮要跟着变）
                    reload(verbose = true)
                } else {
                    btn.text = getString(R.string.plugin_failed, msg.take(28))
                    btn.setTextColor(0xFFF87171.toInt())
                    btn.isEnabled = true
                    btn.isClickable = true
                }
            }
        }
    }

    private fun confirmUninstall(pkg: String, btn: TextView) {
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.plugin_uninstall))
            .setMessage(pkg)
            .setPositiveButton(R.string.plugin_uninstall) { _, _ -> runUninstall(pkg, btn) }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun runUninstall(pkg: String, btn: TextView) {
        btn.text = getString(R.string.plugin_uninstalling)
        btn.isEnabled = false
        btn.setTextColor(0xFF8A94A3.toInt())
        PluginCenter.uninstall(this, pkg) { ok, msg ->
            runOnUiThread {
                if (ok) {
                    btn.text = getString(R.string.plugin_install)
                    btn.setTextColor(0xFF7DD3FC.toInt())
                    btn.isEnabled = true
                    btn.isClickable = true
                    btn.setOnClickListener {
                        runInstall(pkg, btn, pkg)
                    }
                    reload(verbose = true)
                } else {
                    btn.text = getString(R.string.plugin_failed, msg.take(28))
                    btn.setTextColor(0xFFF87171.toInt())
                    btn.isEnabled = true
                    btn.isClickable = true
                }
            }
        }
    }

    companion object {
        private const val STORE_CONTENT_MAX_WIDTH_DP = 720

        /** 从桌宠设置页跳过来时预填搜索词，例如 dsh-pet-bridge。 */
        const val EXTRA_QUERY = "app.dsh.mobile.extra.PLUGIN_QUERY"
    }
}

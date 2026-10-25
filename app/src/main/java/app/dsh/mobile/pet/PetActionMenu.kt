package app.dsh.mobile.pet

import android.content.Context
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import app.dsh.mobile.R

/**
 * 长按动作菜单：全屏 scrim + 底部面板。
 * 不用 Dialog：Service 没有 Activity 的 window token。
 */
class PetActionMenu(
    private val ctx: Context,
    private val wm: WindowManager,
    private val pack: PetPackConfig?,
    private val onAction: (String) -> Unit,
    private val onReset: () -> Unit,
    private val onFlip: () -> Unit,
    private val onSettings: () -> Unit,
    private val onStop: () -> Unit,
) {
    private var root: View? = null
    private val d = ctx.resources.displayMetrics.density

    val isShowing: Boolean get() = root != null

    fun show() {
        if (root != null) return
        val dm = ctx.resources.displayMetrics
        val scrim = FrameLayout(ctx).apply {
            setBackgroundColor(0xB3000000.toInt())
            setOnClickListener { dismiss() }
        }

        val panel = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(14), dp(16), dp(14))
            background = GradientDrawable().apply {
                cornerRadius = 18f * d
                setColor(0xFF161A21.toInt())
                setStroke(dp(1), 0xFF2C3442.toInt())
            }
            setOnClickListener { /* consume */ }
        }
        scrim.addView(
            panel,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                (dm.heightPixels * 0.66f).toInt(),
                Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL,
            ).apply { setMargins(dp(12), 0, dp(12), dp(12)) },
        )

        panel.addView(TextView(ctx).apply {
            text = ctx.getString(R.string.pet_menu_title)
            setTextColor(0xFFEAF1F8.toInt())
            textSize = 16f
            setPadding(dp(4), 0, dp(4), dp(8))
        })

        val scroll = ScrollView(ctx)
        panel.addView(scroll, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        val list = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        scroll.addView(list)

        addRow(list, ctx.getString(R.string.pet_menu_reset)) { dismiss(); onReset() }
        addRow(list, ctx.getString(R.string.pet_menu_flip)) { dismiss(); onFlip() }
        addRow(list, ctx.getString(R.string.pet_menu_settings)) { dismiss(); onSettings() }
        addRow(list, ctx.getString(R.string.pet_menu_stop)) { dismiss(); onStop() }

        val cfg = pack
        if (cfg == null) {
            list.addView(TextView(ctx).apply {
                text = ctx.getString(R.string.pet_menu_no_pack)
                setTextColor(0xFF8A94A3.toInt())
                textSize = 13f
                setPadding(dp(6), dp(12), dp(6), dp(8))
            })
        } else {
            addSection(list, ctx.getString(R.string.pet_menu_idle), cfg.idle)
            addSection(list, ctx.getString(R.string.pet_menu_clicks), cfg.clicks)
            addSection(list, ctx.getString(R.string.pet_menu_random), cfg.categories.flatMap { it.actions }.distinct())
        }

        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
        }

        runCatching {
            wm.addView(scrim, lp)
            root = scrim
        }.onFailure {
            Log.w(TAG, "menu addView failed: ${it.message}")
            root = null
        }
    }

    fun dismiss() {
        val v = root ?: return
        root = null
        runCatching { wm.removeView(v) }
    }

    private fun addSection(list: LinearLayout, title: String, slugs: List<String>) {
        val cfg = pack ?: return
        val visible = slugs.filter { cfg.isAvailable(it) }
        if (visible.isEmpty()) return
        list.addView(TextView(ctx).apply {
            text = "$title (${visible.size})"
            setTextColor(0xFF8FB6E8.toInt())
            textSize = 13f
            setTypeface(typeface, Typeface.BOLD)
            setPadding(dp(6), dp(14), dp(6), dp(6))
        })
        for (slug in visible) {
            val name = cfg.nameOf(slug)
            addRow(list, name) { dismiss(); onAction(slug) }
        }
    }

    private fun addRow(parent: LinearLayout, text: String, onClick: () -> Unit) {
        val tv = TextView(ctx).apply {
            this.text = text
            setTextColor(0xFFCFDCEA.toInt())
            textSize = 14f
            setPadding(dp(18), dp(11), dp(8), dp(11))
            isClickable = true
            setOnClickListener { onClick() }
        }
        parent.addView(
            tv,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ),
        )
    }

    private fun dp(v: Int): Int = (v * d).toInt()

    companion object {
        private const val TAG = "DshPetMenu"
    }
}

package app.dsh.mobile.pet

import org.json.JSONObject
import java.util.Locale

/**
 * dsh-pet-bridge 的五字段协议。
 *
 * 真实契约（dsh-pet-bridge@0.1.0，lib/bubble.js）：
 *   { kind, agent_source, tool_name, tool_input, caller_pid }
 *
 * - kind: user / pre / post / stop
 * - tool_name: 原始工具名（只有 pre 有值）
 * - tool_input: 桥侧已经裁过的摘要对象，只有 file_path / command / pattern / query 四种键
 * - caller_pid: 引擎进程 pid（只用于诊断，不做鉴权）
 *
 * 注意：协议里**没有气泡文本**。气泡由原生侧根据 kind + tool_name + tool_input 拼。
 */
data class PetEvent(
    val kind: String,
    val agentSource: String?,
    val toolName: String?,
    val toolInputKey: String?,
    val toolInputValue: String?,
    val callerPid: Int,
    val receivedAt: Long = System.currentTimeMillis(),
)

object PetProtocol {
    const val PORT = 7779
    const val MAX_BODY_BYTES = 8 * 1024
    const val MAX_HEADER_BYTES = 8 * 1024
    const val MAX_TOOL_NAME_CHARS = 64
    const val MAX_SUMMARY_CHARS = 32

    private val KINDS = setOf("user", "pre", "post", "stop", "error", "waiting")
    private val INPUT_KEYS = listOf("file_path", "command", "pattern", "query")

    /**
     * 解析请求体。任何字段缺失/类型非法都返回 null，调用方回 400，不改变宠物状态。
     * 不抛异常：HTTP 线程必须能继续服务下一条请求。
     */
    fun parse(body: String): PetEvent? = runCatching {
        val obj = JSONObject(body)
        val kind = obj.optString("kind", "").lowercase(Locale.US)
        if (kind !in KINDS) return null

        val toolName = optStringOrNull(obj, "tool_name")
            ?.let { sanitize(it, MAX_TOOL_NAME_CHARS) }
            ?.takeIf { it.isNotEmpty() }

        val input = obj.optJSONObject("tool_input")
        var inputKey: String? = null
        var inputValue: String? = null
        if (input != null) {
            for (key in INPUT_KEYS) {
                val raw = optStringOrNull(input, key) ?: continue
                val normalized = when (key) {
                    "file_path" -> basename(raw)
                    "command" -> firstWord(raw)
                    else -> raw
                }
                val clean = sanitize(normalized, MAX_SUMMARY_CHARS)
                if (!clean.isNullOrEmpty()) {
                    inputKey = key
                    inputValue = clean
                    break
                }
            }
        }

        PetEvent(
            kind = kind,
            agentSource = optStringOrNull(obj, "agent_source")?.let { sanitize(it, 32) },
            toolName = toolName,
            toolInputKey = inputKey,
            toolInputValue = inputValue,
            callerPid = obj.optInt("caller_pid", -1),
        )
    }.getOrNull()

    /** 去掉控制字符、换行、双向覆盖字符；压缩空白；按 code point 截断。 */
    fun sanitize(value: String?, maxChars: Int = MAX_SUMMARY_CHARS): String? {
        if (value == null) return null
        val cleaned = value
            .replace(Regex("[\\u0000-\\u001F\\u007F-\\u009F\\u202A-\\u202E\\u2066-\\u2069]"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()
        if (cleaned.isEmpty()) return null
        return takeCodePoints(cleaned, maxChars)
    }

    /** 只取文件名，不把完整路径显示到桌面上。 */
    fun basename(path: String): String =
        path.replace('\\', '/').split('/').lastOrNull { it.isNotBlank() }.orEmpty()

    /** 命令只显示第一个词，避免把整条命令行带到悬浮窗。 */
    fun firstWord(command: String): String =
        command.trim().split(Regex("\\s+")).firstOrNull().orEmpty()

    private fun takeCodePoints(value: String, max: Int): String {
        if (max <= 0) return ""
        val count = value.codePointCount(0, value.length)
        if (count <= max) return value
        return value.substring(0, value.offsetByCodePoints(0, max))
    }

    private fun optStringOrNull(obj: JSONObject, key: String): String? {
        if (!obj.has(key) || obj.isNull(key)) return null
        return runCatching { obj.getString(key) }.getOrNull()
    }
}

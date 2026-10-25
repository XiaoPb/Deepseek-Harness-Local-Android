package app.dsh.mobile.pet

import android.util.Log
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * 仅回环的极简 HTTP 接收器。
 *
 * 没有引入 NanoHTTPD：本仓库已有 AgentBridge / ShizukuHttpBridge 两处原生
 * ServerSocket 先例，这里复用同样的形态，避免为了一个 POST 增加依赖。
 *
 * 约束：
 *  - 只绑 127.0.0.1:7779，绝不 0.0.0.0；
 *  - 请求行+头 ≤8KB、body ≤8KB、socket 5s 超时；
 *  - 2 个 worker，避免慢连接把 accept 线程卡住；
 *  - 任何解析失败只回 4xx/5xx，不抛到 Service。
 */
class PetBridgeServer(
    private val onEvent: (PetEvent) -> Unit,
    private val onError: (String) -> Unit,
) {
    private val TAG = "DshPetBridge"
    private val SOCKET_TIMEOUT_MS = 5_000

    @Volatile private var running = false
    @Volatile private var serverSocket: ServerSocket? = null
    @Volatile private var workers: ExecutorService? = null
    @Volatile private var acceptThread: Thread? = null

    val isRunning: Boolean get() = running

    fun start() {
        if (running) return
        running = true
        workers = Executors.newFixedThreadPool(2) { r ->
            Thread(r, "dsh-pet-bridge-worker").apply { isDaemon = true }
        }
        acceptThread = Thread({ acceptLoop() }, "dsh-pet-bridge-accept").apply {
            isDaemon = true
            start()
        }
    }

    fun stop() {
        running = false
        runCatching { serverSocket?.close() }
        serverSocket = null
        runCatching { workers?.shutdownNow() }
        workers = null
        acceptThread = null
    }

    private fun acceptLoop() {
        try {
            val ss = ServerSocket()
            ss.reuseAddress = true
            ss.bind(
                InetSocketAddress(InetAddress.getByName("127.0.0.1"), PetProtocol.PORT),
                8,
            )
            serverSocket = ss
            Log.i(TAG, "listening on 127.0.0.1:${PetProtocol.PORT}")
            while (running) {
                val client = try {
                    ss.accept()
                } catch (e: Exception) {
                    if (running) {
                        Log.w(TAG, "accept failed: ${e.message}")
                        onError("accept_failed")
                    }
                    break
                }
                val pool = workers
                if (pool == null || pool.isShutdown) {
                    runCatching { client.close() }
                    break
                }
                runCatching {
                    pool.execute { handle(client) }
                }.onFailure {
                    Log.w(TAG, "dispatch failed: ${it.message}")
                    runCatching { client.close() }
                }
            }
        } catch (e: Exception) {
            if (running) {
                Log.w(TAG, "bind failed on 127.0.0.1:${PetProtocol.PORT}: ${e.message}")
                onError("port_busy")
            }
        } finally {
            running = false
            runCatching { serverSocket?.close() }
            serverSocket = null
        }
    }

    private fun handle(client: Socket) {
        try {
            client.soTimeout = SOCKET_TIMEOUT_MS
            val input = BufferedInputStream(client.getInputStream())
            val output = BufferedOutputStream(client.getOutputStream())

            val requestLine = readLine(input, PetProtocol.MAX_HEADER_BYTES) ?: run {
                respond(output, 400, "Bad Request")
                return
            }
            val parts = requestLine.split(' ')
            if (parts.size < 2) {
                respond(output, 400, "Bad Request")
                return
            }
            val method = parts[0].uppercase()
            val path = parts[1].substringBefore('?')

            var headerBytes = requestLine.length + 2
            var contentLength = 0
            while (true) {
                val line = readLine(input, PetProtocol.MAX_HEADER_BYTES - headerBytes) ?: run {
                    respond(output, 431, "Request Header Fields Too Large")
                    return
                }
                if (line.isEmpty()) break
                headerBytes += line.length + 2
                if (headerBytes > PetProtocol.MAX_HEADER_BYTES) {
                    respond(output, 431, "Request Header Fields Too Large")
                    return
                }
                val idx = line.indexOf(':')
                if (idx <= 0) continue
                val name = line.substring(0, idx).trim()
                val value = line.substring(idx + 1).trim()
                if (name.equals("Content-Length", ignoreCase = true)) {
                    contentLength = value.toIntOrNull() ?: -1
                }
            }

            if (method == "GET" && path == "/ping") {
                respond(
                    output, 200, "OK",
                    """{"ok":true,"service":"pet-overlay","protocol":1}""",
                    "application/json",
                )
                return
            }
            if (path != "/bubble") {
                respond(output, 404, "Not Found")
                return
            }
            if (method != "POST") {
                respond(output, 405, "Method Not Allowed")
                return
            }
            if (contentLength <= 0 || contentLength > PetProtocol.MAX_BODY_BYTES) {
                respond(output, if (contentLength > PetProtocol.MAX_BODY_BYTES) 413 else 400, "Bad Request")
                return
            }

            val body = ByteArray(contentLength)
            var read = 0
            while (read < contentLength) {
                val n = input.read(body, read, contentLength - read)
                if (n < 0) break
                read += n
            }
            if (read != contentLength) {
                respond(output, 400, "Bad Request")
                return
            }

            val event = PetProtocol.parse(String(body, Charsets.UTF_8))
            if (event == null) {
                respond(output, 400, "Bad Request")
                return
            }
            runCatching { onEvent(event) }
                .onFailure { Log.w(TAG, "event callback failed: ${it.message}") }
            respond(output, 204, "No Content")
        } catch (e: Exception) {
            // 超时/断连/格式错误都静默；下一轮继续服务
            Log.d(TAG, "request ended: ${e.message}")
        } finally {
            runCatching { client.close() }
        }
    }

    private fun respond(
        output: OutputStream,
        code: Int,
        reason: String,
        body: String = "",
        contentType: String? = null,
    ) {
        val bytes = body.toByteArray(Charsets.UTF_8)
        val sb = StringBuilder()
        sb.append("HTTP/1.1 ").append(code).append(' ').append(reason).append("\r\n")
        sb.append("Content-Length: ").append(bytes.size).append("\r\n")
        sb.append("Connection: close\r\n")
        if (contentType != null) sb.append("Content-Type: ").append(contentType).append("\r\n")
        sb.append("\r\n")
        output.write(sb.toString().toByteArray(Charsets.US_ASCII))
        if (bytes.isNotEmpty()) output.write(bytes)
        output.flush()
    }

    /** 按字节读一行，限制总长度；返回 null 表示超限/连接断开。 */
    private fun readLine(input: InputStream, max: Int): String? {
        if (max <= 0) return null
        val sb = StringBuilder()
        var count = 0
        while (true) {
            val b = input.read()
            if (b < 0) return if (sb.isEmpty()) null else sb.toString()
            if (b == '\n'.code) break
            if (b == '\r'.code) continue
            count++
            if (count > max) return null
            sb.append(b.toChar())
        }
        return sb.toString()
    }
}

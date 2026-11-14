package com.aureth.aurabot.mobile

import java.io.Closeable
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicInteger

/**
 * 手机本机 127.0.0.1:[LOCAL_PORT] → 电脑 host:port 的 TCP 原样转发。
 *
 * 为什么要它：手机端网页在局域网 http 下不是「安全环境」，浏览器不给录音、相机。
 * 127.0.0.1 在浏览器眼里算安全环境，所以 WebView 打开本机端口，字节原样转给电脑。
 * HTTP 和 WebSocket 都只是字节流，不解析、不改写；电脑端按 Host/Origin 做的同源检查照常成立
 * （两者都是 127.0.0.1:端口），鉴权仍是电脑端发给这台手机的设备令牌。
 *
 * 只监听回环地址，局域网里别的设备连不到这个口。
 */
class Forwarder private constructor(val host: String, val port: Int) {
    private val pool: ExecutorService = Executors.newCachedThreadPool { r ->
        Thread(r, "aurabot-forward").apply { isDaemon = true }
    }
    private val activeSockets = ConcurrentHashMap.newKeySet<Socket>()
    @Volatile private var stopped = false
    @Volatile private var server: ServerSocket? = null

    @Throws(IOException::class)
    private fun start() {
        val s = ServerSocket()
        try {
            s.reuseAddress = true
            s.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), LOCAL_PORT), 64)
            server = s
            pool.execute { acceptLoop(s) }
        } catch (e: Exception) {
            closeQuietly(s)
            stop()
            if (e is IOException) throw e
            throw IOException(e.message, e)
        }
    }

    private fun acceptLoop(s: ServerSocket) {
        while (!stopped && !s.isClosed) {
            val client = try { s.accept() } catch (_: IOException) { break }
            if (stopped) {
                closeQuietly(client)
                break
            }
            activeSockets.add(client)
            try {
                pool.execute { bridge(client) }
            } catch (_: RejectedExecutionException) {
                activeSockets.remove(client)
                closeQuietly(client)
            }
        }
    }

    private fun bridge(client: Socket) {
        if (stopped) {
            closeAndUntrack(client)
            return
        }
        val upstream = Socket()
        activeSockets.add(upstream)
        try {
            upstream.connect(InetSocketAddress(host, port), CONNECT_TIMEOUT_MS)
            upstream.tcpNoDelay = true
            client.tcpNoDelay = true
        } catch (_: Exception) {
            // 连不上电脑：直接断开，WebView 会报加载失败，由界面提示检查网络。
            closeAndUntrack(client, upstream)
            return
        }
        if (stopped) {
            closeAndUntrack(client, upstream)
            return
        }
        val remaining = AtomicInteger(2)
        try {
            pool.execute { pump(client, upstream, remaining) }
        } catch (_: RejectedExecutionException) {
            closeAndUntrack(client, upstream)
            return
        }
        pump(upstream, client, remaining)
    }

    private fun pump(from: Socket, to: Socket, remaining: AtomicInteger) {
        val buf = ByteArray(16 * 1024)
        var broken = false
        try {
            val input = from.getInputStream()
            val output = to.getOutputStream()
            while (!stopped) {
                val n = input.read(buf)
                if (n < 0) {
                    runCatching { to.shutdownOutput() }
                    break
                }
                output.write(buf, 0, n)
                output.flush()
            }
        } catch (_: IOException) {
            broken = true
        } finally {
            // 任意错误或两边都读完时立即关闭并释放追踪集合；stop() 时也会主动关掉全部活跃 socket 以解除 read 阻塞。
            if (broken || stopped || remaining.decrementAndGet() <= 0) {
                closeAndUntrack(from, to)
            }
        }
    }

    private fun closeAndUntrack(vararg sockets: Socket) {
        for (s in sockets) {
            activeSockets.remove(s)
            closeQuietly(s)
        }
    }

    private fun stop() {
        stopped = true
        closeQuietly(server)
        server = null
        val snapshot = activeSockets.toList()
        activeSockets.clear()
        for (s in snapshot) closeQuietly(s)
        pool.shutdownNow()
    }

    companion object {
        /** 固定端口：网页的本地存储按来源（含端口）保存，端口变了就等于换了网站、要重新配对。 */
        const val LOCAL_PORT = 38417
        const val LOCAL_BASE = "http://127.0.0.1:$LOCAL_PORT"
        private const val CONNECT_TIMEOUT_MS = 8000

        private var current: Forwarder? = null

        /** 确保有一个转发到 host:port 的转发器在跑；目标变了就换掉旧的。 */
        @Synchronized
        @Throws(IOException::class)
        fun ensure(host: String, port: Int) {
            val running = current
            if (running != null && !running.stopped && running.host == host && running.port == port && running.server?.isClosed == false) {
                return
            }
            running?.stop()
            current = null
            val next = Forwarder(host, port)
            next.start()
            current = next
        }

        @Synchronized
        fun stopAll() {
            current?.stop()
            current = null
        }

        private fun closeQuietly(vararg items: Closeable?) {
            for (c in items) try { c?.close() } catch (_: IOException) {}
        }
    }
}

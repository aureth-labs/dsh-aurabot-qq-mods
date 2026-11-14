package com.aureth.aurabot.mobile

import org.json.JSONObject
import java.net.URI

/** 电脑地址：只认 http(s)://主机:端口，不带账号密码。 */
data class Server(val scheme: String, val host: String, val port: Int) {
    val origin: String
        get() {
            val h = if (host.contains(':')) "[$host]" else host
            val defaultPort = if (scheme == "https") 443 else 80
            return if (port == defaultPort) "$scheme://$h" else "$scheme://$h:$port"
        }
    val secure: Boolean get() = scheme == "https"

    /** WebView 实际打开的根地址：https 直连；http 走本机转发。 */
    val base: String get() = if (secure) origin else Forwarder.LOCAL_BASE

    /** 判断某个 URL 或 origin（如 PermissionRequest.origin）是否严格属于当前 WebView 加载的来源。 */
    fun matchesWebOrigin(rawUrl: String?): Boolean {
        val candidate = parseNormalized(rawUrl) ?: return false
        val expected = if (secure) this else LOCAL_SERVER
        return candidate == expected
    }

    companion object {
        private val LOCAL_SERVER = Server("http", "127.0.0.1", Forwarder.LOCAL_PORT)

        fun parse(raw: String): Server {
            val uri = try { URI(raw.trim()) } catch (_: Exception) { throw IllegalArgumentException("地址格式不对") }
            val scheme = uri.scheme?.lowercase()
            if (scheme != "http" && scheme != "https") throw IllegalArgumentException("地址要以 http:// 或 https:// 开头")
            if (uri.rawUserInfo != null) throw IllegalArgumentException("地址里不能带账号密码")
            // 主机名统一小写，和浏览器的 URL.origin 一致，避免同一台电脑被当成两台而清掉令牌。
            val host = uri.host?.removePrefix("[")?.removeSuffix("]")?.lowercase()
            if (host.isNullOrBlank()) throw IllegalArgumentException("地址里没有电脑的主机名或 IP")
            if (uri.port > 65535) throw IllegalArgumentException("端口不对")
            val port = effectivePort(scheme, uri.port)
            return Server(scheme, host, port)
        }

        private fun parseNormalized(raw: String?): Server? {
            if (raw.isNullOrBlank()) return null
            val uri = try { URI(raw.trim()) } catch (_: Exception) { return null }
            val scheme = uri.scheme?.lowercase() ?: return null
            if (scheme != "http" && scheme != "https") return null
            if (uri.rawUserInfo != null) return null
            val host = uri.host?.removePrefix("[")?.removeSuffix("]")?.lowercase() ?: return null
            if (host.isBlank() || uri.port > 65535) return null
            return Server(scheme, host, effectivePort(scheme, uri.port))
        }

        private fun effectivePort(scheme: String, port: Int): Int =
            if (port > 0) port else if (scheme == "https") 443 else 80
    }
}

/** 二维码或粘贴的内容：电脑面板给的是 http(s)://电脑:端口/?code=…，也兼容 {"url":…,"code":…}。 */
data class Pairing(val server: Server, val code: String?) {
    companion object {
        fun parse(raw: String): Pairing {
            val value = raw.trim()
            if (value.isEmpty()) throw IllegalArgumentException("内容是空的")
            if (value.startsWith("{")) {
                val json = try { JSONObject(value) } catch (_: Exception) { throw IllegalArgumentException("二维码内容不认识") }
                val server = Server.parse(json.optString("url"))
                return Pairing(server, cleanCode(json.optString("code")))
            }
            val server = Server.parse(value)
            val code = try { URI(value).rawQuery } catch (_: Exception) { null }
                ?.split('&')
                ?.firstOrNull { it.startsWith("code=") }
                ?.substringAfter("code=")
                ?.let { java.net.URLDecoder.decode(it, "UTF-8") }
            return Pairing(server, cleanCode(code))
        }

        private fun cleanCode(code: String?): String? {
            val c = code?.trim().orEmpty()
            if (c.isEmpty()) return null
            if (c.length > 128) throw IllegalArgumentException("配对码太长，不像是电脑面板给的")
            return c
        }
    }
}

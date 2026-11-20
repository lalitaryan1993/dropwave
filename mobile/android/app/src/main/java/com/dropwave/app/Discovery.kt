package com.dropwave.app

import android.content.Context
import android.net.wifi.WifiManager
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetSocketAddress
import java.net.SocketTimeoutException

/**
 * Finds DropWave PCs on this Wi-Fi by listening for the "I'm here" broadcast every PC sends every
 * 2 seconds (UDP 47821). Instant, and it notices when a PC's address changed.
 */
object Discovery {
    private const val PORT = 47821

    fun listen(ctx: Context, ms: Long): JSObject {
        val wifi = ctx.applicationContext.getSystemService(WifiManager::class.java)
        val lock = runCatching { wifi.createMulticastLock("dropwave-discovery").apply { setReferenceCounted(false); acquire() } }.getOrNull()
        val found = LinkedHashMap<String, JSObject>()
        try {
            DatagramSocket(null).use { s ->
                s.reuseAddress = true
                s.broadcast = true
                s.bind(InetSocketAddress(PORT))
                val buf = ByteArray(4096)
                val end = System.currentTimeMillis() + ms.coerceIn(300, 8000)
                while (true) {
                    val left = end - System.currentTimeMillis()
                    if (left <= 0) break
                    s.soTimeout = left.toInt().coerceAtLeast(1)
                    val p = DatagramPacket(buf, buf.size)
                    try { s.receive(p) } catch (_: SocketTimeoutException) { break }
                    val j = runCatching { JSONObject(String(p.data, 0, p.length, Charsets.UTF_8)) }.getOrNull() ?: continue
                    if (j.optString("app") != "dropwave" || j.optBoolean("bye") || j.optInt("web", 0) <= 0) continue
                    val id = j.optString("id")
                    if (id.isEmpty()) continue
                    found[id] = JSObject().put("id", id).put("name", j.optString("name", "PC"))
                        .put("address", p.address.hostAddress).put("web", j.optInt("web"))
                }
            }
        } catch (_: Exception) {
            // Port busy or no Wi-Fi: the page falls back to scanning.
        } finally {
            runCatching { lock?.release() }
        }
        val list = JSArray()
        found.values.forEach { list.put(it) }
        return JSObject().put("list", list)
    }
}

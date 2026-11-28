package com.dropwave.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.util.Base64
import android.util.Log
import androidx.core.content.ContextCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

/**
 * Phone to phone, without a PC and without internet.
 * This phone makes its own Wi-Fi (Android's local-only hotspot: no internet is shared) or uses
 * the Wi-Fi it is on, and serves the chosen files on a small web server. The other phone joins
 * by QR code and opens a page in its browser (no app needed, iPhones too), or, with DropWave,
 * scans one QR in the app and receives everything natively (see P2PReceive).
 * Only someone with the QR code can open it: every share has a new random token in the link,
 * and an optional 4-digit PIN.
 */
object P2P {
    const val PORT = 47830
    const val APK_NAME = "DropWave.apk"

    /** kind: photo | video | app | contacts | file */
    class Item(val name: String, val size: Long, val mime: String, val kind: String, val uri: Uri? = null, val file: File? = null, val ref: String? = null) {
        val id = nextId.incrementAndGet()
    }
    private val nextId = java.util.concurrent.atomic.AtomicInteger(0)

    private val items = CopyOnWriteArrayList<Item>()
    private val received = CopyOnWriteArrayList<JSObject>()
    private val guests = ConcurrentHashMap<String, String>() // ip -> device name
    private var server: ServerSocket? = null
    private val pool = Executors.newCachedThreadPool()
    private var reservation: WifiManager.LocalOnlyHotspotReservation? = null
    private var token = ""
    private var pin = ""
    private var ssid = ""
    private var pass = ""
    private var ip = ""
    private var mode = "" // "hotspot" | "wifi"
    private var sentBytes = 0L
    private lateinit var app: Context

    // ---------- who may send files to this phone ----------
    // A phone asks once before sending ("Redmi wants to send 5 files"); the person here accepts or
    // declines, and can trust it so later files are accepted by themselves. An accepted phone may
    // send for 10 minutes. Phones are told apart by an id they keep (the guest page keeps one in the
    // browser, DropWave uses this phone's own).
    private val approved = ConcurrentHashMap<String, Long>() // gid -> until (ms)
    private val asks = ConcurrentHashMap<String, java.util.concurrent.CompletableFuture<Boolean>>()
    private fun prefs(ctx: Context) = ctx.getSharedPreferences("p2p", Context.MODE_PRIVATE)
    fun trusted(ctx: Context): org.json.JSONObject = runCatching { org.json.JSONObject(prefs(ctx).getString("trusted", "{}")!!) }.getOrDefault(org.json.JSONObject())
    fun trust(ctx: Context, gid: String, name: String) { val t = trusted(ctx).put(gid, name); prefs(ctx).edit().putString("trusted", t.toString()).apply() }
    fun untrust(ctx: Context, gid: String) { val t = trusted(ctx); t.remove(gid); prefs(ctx).edit().putString("trusted", t.toString()).apply() }
    /** This phone's own id, when it sends to another phone. */
    fun myId(ctx: Context): String = prefs(ctx).getString("id", null) ?: java.util.UUID.randomUUID().toString().also { prefs(ctx).edit().putString("id", it).apply() }
    private fun allowed(gid: String) = gid.isNotEmpty() && (trusted(app).has(gid) || (approved[gid] ?: 0L) > System.currentTimeMillis())

    /** The answer from the accept sheet. trustIt: always accept this phone from now on. */
    fun answer(id: String, ok: Boolean, trustIt: Boolean, gid: String, name: String) {
        if (ok) { approved[gid] = System.currentTimeMillis() + 10 * 60 * 1000; if (trustIt) trust(app, gid, name) }
        asks.remove(id)?.complete(ok)
    }

    val running get() = server != null

    // ---------- what to share ----------

    private fun kindOf(mime: String, name: String) = when {
        name.endsWith(".apk", true) -> "app"
        name.endsWith(".vcf", true) -> "contacts"
        mime.startsWith("image/") -> "photo"
        mime.startsWith("video/") -> "video"
        else -> "file"
    }

    fun addUris(ctx: Context, uris: List<Uri>) {
        val cr = ctx.contentResolver
        for (u in uris) {
            if (items.any { it.uri == u }) continue
            var name = "file"
            var size = -1L
            runCatching {
                cr.query(u, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                    if (c.moveToFirst()) {
                        c.getString(0)?.let { name = it }
                        if (!c.isNull(1)) size = c.getLong(1)
                    }
                }
            }
            val mime = cr.getType(u) ?: MediaSaver.mimeOf(name)
            items.add(Item(name, size, mime, kindOf(mime, name), uri = u))
        }
        changed()
    }

    /** Gallery items picked in DropWave's own picker ("i123" / "v456"). */
    fun addRefs(ctx: Context, refs: List<String>) {
        val have = items.mapNotNull { it.ref }.toHashSet()
        val fresh = refs.filter { it !in have }.mapNotNull { r -> PhotoLibrary.uriOf(r)?.let { r to it } }
        val cr = ctx.contentResolver
        for ((ref, u) in fresh) {
            var name = if (ref.startsWith("v")) "video.mp4" else "photo.jpg"
            var size = -1L
            runCatching {
                cr.query(u, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                    if (c.moveToFirst()) { c.getString(0)?.let { name = it }; if (!c.isNull(1)) size = c.getLong(1) }
                }
            }
            val mime = cr.getType(u) ?: MediaSaver.mimeOf(name)
            items.add(Item(name, size, mime, if (ref.startsWith("v")) "video" else "photo", uri = u, ref = ref))
        }
        changed()
    }

    /** Installed apps (single-APK ones), so the other phone can install them. */
    fun addApps(ctx: Context, pkgs: List<String>): Int {
        var skipped = 0
        for (pkg in pkgs) {
            if (pkg == ctx.packageName) { addApp(ctx); continue }
            val (f, name) = Apps.apk(ctx, pkg) ?: run { skipped++; null } ?: continue
            if (items.any { it.file?.absolutePath == f.absolutePath }) continue
            items.add(Item(name, f.length(), "application/vnd.android.package-archive", "app", file = f, ref = "app:$pkg"))
        }
        changed()
        return skipped
    }

    fun addPaths(paths: List<String>) {
        for (p in paths) {
            val f = File(p)
            if (!f.isFile || items.any { it.file?.absolutePath == f.absolutePath }) continue
            val mime = MediaSaver.mimeOf(f.name)
            items.add(Item(f.name, f.length(), mime, kindOf(mime, f.name), file = f))
        }
        changed()
    }

    /** The DropWave app itself, so the other phone can install it. */
    fun addApp(ctx: Context) {
        if (items.any { it.name == APK_NAME }) return
        val f = File(ctx.applicationInfo.sourceDir)
        items.add(Item(APK_NAME, f.length(), "application/vnd.android.package-archive", "app", file = f, ref = "app:self"))
        changed()
    }

    /** All contacts as one .vcf file (the other phone imports it in Contacts). Returns how many. */
    fun addContacts(ctx: Context, only: Set<Long>? = null): Int {
        val all = Contacts.list(ctx, 20000).getJSONArray("list")
        val list = org.json.JSONArray()
        for (k in 0 until all.length()) { val c = all.getJSONObject(k); if (only == null || c.optLong("id") in only) list.put(c) }
        if (list.length() == 0) return 0
        val sb = StringBuilder()
        fun v(s: String) = s.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")
        for (k in 0 until list.length()) {
            val c = list.getJSONObject(k)
            val name = c.optString("name")
            sb.append("BEGIN:VCARD\r\nVERSION:3.0\r\nFN:").append(v(name)).append("\r\nN:;").append(v(name)).append(";;;\r\n")
            val nums = c.optJSONArray("numbers")
            if (nums != null) for (j in 0 until nums.length()) sb.append("TEL;TYPE=CELL:").append(nums.getJSONObject(j).optString("n")).append("\r\n")
            val mails = c.optJSONArray("emails")
            if (mails != null) for (j in 0 until mails.length()) sb.append("EMAIL:").append(v(mails.optString(j))).append("\r\n")
            sb.append("END:VCARD\r\n")
        }
        val f = File(ctx.cacheDir, if (list.length() == 1) "p2p/${list.getJSONObject(0).optString("name").replace(Regex("[\\\\/:*?\"<>|]"), "_")}.vcf" else "p2p/Contacts (${list.length()}).vcf")
        f.parentFile?.mkdirs()
        f.parentFile?.listFiles { x -> x.name.endsWith(".vcf") }?.forEach { it.delete() }
        f.writeText(sb.toString())
        items.removeAll { it.kind == "contacts" }
        items.add(Item(f.name, f.length(), "text/x-vcard", "contacts", file = f, ref = "contacts"))
        changed()
        return list.length()
    }

    fun remove(id: Int) { items.removeAll { it.id == id }; changed() }
    fun removeAll() { items.clear(); changed() }

    // ---------- start / stop ----------

    /** What is missing before the hotspot can start: "permission" | "location" | null. */
    fun missing(ctx: Context): String? {
        if (Build.VERSION.SDK_INT >= 33) {
            if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.NEARBY_WIFI_DEVICES) != PackageManager.PERMISSION_GRANTED) return "permission"
        } else {
            if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) return "permission"
            val lm = ctx.getSystemService(LocationManager::class.java)
            if (lm != null && !lm.isLocationEnabled) return "location"
        }
        return null
    }
    fun permissions(): Array<String> = if (Build.VERSION.SDK_INT >= 33) arrayOf(Manifest.permission.NEARBY_WIFI_DEVICES) else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)

    /** hotspot = make DropWave's own Wi-Fi; otherwise share on the Wi-Fi this phone is on. withPin = ask for a 4-digit PIN. */
    @SuppressLint("MissingPermission")
    fun start(ctx: Context, hotspot: Boolean, withPin: Boolean, done: (JSObject?, String?) -> Unit) {
        app = ctx.applicationContext
        stop()
        token = randomToken()
        pin = if (withPin) (1000 + SecureRandom().nextInt(9000)).toString() else ""
        received.clear(); guests.clear(); sentBytes = 0
        try { startServer() } catch (e: Exception) { return done(null, "Couldn’t start sharing: ${e.message}") }
        if (!hotspot) {
            val a = wifiIp(app) ?: run { stop(); return done(null, "This phone isn’t on a Wi-Fi. Use “DropWave Wi-Fi” instead.") }
            ip = a; mode = "wifi"
            announce()
            return done(info(), null)
        }
        val wm = app.getSystemService(WifiManager::class.java) ?: run { stop(); return done(null, "No Wi-Fi on this phone") }
        try {
            wm.startLocalOnlyHotspot(object : WifiManager.LocalOnlyHotspotCallback() {
                override fun onStarted(r: WifiManager.LocalOnlyHotspotReservation) {
                    reservation = r
                    if (Build.VERSION.SDK_INT >= 30) {
                        val c = r.softApConfiguration
                        ssid = (if (Build.VERSION.SDK_INT >= 33) c.wifiSsid?.toString()?.trim('"') else @Suppress("DEPRECATION") c.ssid) ?: ""
                        pass = c.passphrase ?: ""
                    } else {
                        @Suppress("DEPRECATION") val c = r.wifiConfiguration
                        @Suppress("DEPRECATION") run { ssid = c?.SSID?.trim('"') ?: ""; pass = c?.preSharedKey?.trim('"') ?: "" }
                    }
                    mode = "hotspot"
                    // The hotspot's address shows up a moment after it starts.
                    val h = Handler(Looper.getMainLooper())
                    var tries = 0
                    fun look() {
                        val a = hotspotIp(app)
                        if (a != null || tries++ > 20) { ip = a ?: "192.168.43.1"; done(info(), null) }
                        else h.postDelayed({ look() }, 250)
                    }
                    look()
                }
                override fun onStopped() { Log.i(TAG, "p2p: hotspot stopped"); reservation = null; DropWavePlugin.emitOnly("p2p", JSObject().put("type", "stopped")) }
                override fun onFailed(reason: Int) {
                    stop()
                    done(null, when (reason) {
                        ERROR_TETHERING_DISALLOWED -> "This phone doesn’t allow its own Wi-Fi. Use “Same Wi-Fi” instead."
                        ERROR_INCOMPATIBLE_MODE -> "Turn off Mobile hotspot first, then try again."
                        else -> "Couldn’t start DropWave Wi-Fi. Turn off Mobile hotspot and try again, or use “Same Wi-Fi”."
                    })
                }
            }, Handler(Looper.getMainLooper()))
        } catch (e: Exception) {
            stop()
            done(null, e.message ?: "Couldn’t start DropWave Wi-Fi")
        }
    }

    fun stop() {
        asks.values.forEach { it.complete(false) }; asks.clear(); approved.clear()
        if (::app.isInitialized) unannounce()
        runCatching { server?.close() }
        server = null
        runCatching { reservation?.close() }
        reservation = null
        ssid = ""; pass = ""; ip = ""; mode = ""; pin = ""
        guests.clear()
    }

    /** Stop and forget the chosen files. */
    fun clear() { stop(); items.clear(); received.clear() }

    private fun itemsJson(): JSArray {
        val list = JSArray()
        items.forEach {
            list.put(JSObject().put("i", it.id).put("name", it.name).put("size", it.size).put("type", it.mime).put("kind", it.kind)
                .put("ref", it.ref ?: JSONNull).put("app", it.name == APK_NAME))
        }
        return list
    }
    private val JSONNull = org.json.JSONObject.NULL

    fun info(): JSObject {
        val o = JSObject().put("running", running).put("mode", mode).put("sentBytes", sentBytes)
        o.put("items", itemsJson())
        val g = JSArray(); guests.values.forEach { g.put(it) }
        o.put("guests", g)
        val got = JSArray(); received.forEach { got.put(it) }
        o.put("received", got)
        if (running && ip.isNotEmpty()) {
            val url = "http://$ip:$PORT/s/$token/"
            o.put("url", url).put("qrLink", qr(url)).put("pin", pin)
            if (mode == "hotspot") {
                o.put("ssid", ssid).put("pass", pass)
                o.put("qrWifi", qr("WIFI:T:WPA;S:${esc(ssid)};P:${esc(pass)};;"))
            }
        }
        return o
    }

    private fun esc(s: String) = s.replace(Regex("([\\\\;,:\"])"), "\\\\$1")
    private fun changed() = DropWavePlugin.emitOnly("p2p", JSObject().put("type", "changed"))
    private fun randomToken(): String {
        val b = ByteArray(9); SecureRandom().nextBytes(b)
        return Base64.encodeToString(b, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    }

    fun qr(text: String): String {
        val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0, mapOf(EncodeHintType.MARGIN to 1))
        val scale = 8
        val px = IntArray(m.width * scale * m.height * scale)
        val w = m.width * scale
        for (y in 0 until m.height) for (x in 0 until m.width) {
            val c = if (m[x, y]) Color.rgb(11, 13, 20) else Color.WHITE
            for (dy in 0 until scale) for (dx in 0 until scale) px[(y * scale + dy) * w + x * scale + dx] = c
        }
        val bmp = Bitmap.createBitmap(px, w, m.height * scale, Bitmap.Config.RGB_565)
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
        return "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }

    // ---------- addresses ----------

    private fun ipv4s(): List<Pair<String, String>> = runCatching {
        NetworkInterface.getNetworkInterfaces().toList().filter { it.isUp && !it.isLoopback }.flatMap { n ->
            n.inetAddresses.toList().filterIsInstance<Inet4Address>().filter { it.isSiteLocalAddress }.map { n.name to it.hostAddress!! }
        }
    }.getOrDefault(emptyList())

    private fun wifiIp(ctx: Context): String? {
        val cm = ctx.getSystemService(ConnectivityManager::class.java) ?: return null
        @Suppress("DEPRECATION")
        for (n in cm.allNetworks) {
            val caps = cm.getNetworkCapabilities(n) ?: continue
            if (!caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) continue
            cm.getLinkProperties(n)?.linkAddresses?.map { it.address }?.filterIsInstance<Inet4Address>()?.firstOrNull()?.let { return it.hostAddress }
        }
        return null
    }

    private fun hotspotIp(ctx: Context): String? {
        val sta = wifiIp(ctx)
        val all = ipv4s().filter { it.second != sta && !it.first.startsWith("rmnet") && !it.first.startsWith("ccmni") && !it.first.startsWith("tun") }
        return (all.firstOrNull { Regex("^(ap|swlan|softap|wlan1|wlan2)").containsMatchIn(it.first) } ?: all.firstOrNull())?.second
    }

    // ---------- the web server ----------

    private fun startServer() {
        val s = ServerSocket()
        s.reuseAddress = true
        s.bind(java.net.InetSocketAddress(PORT), 32)
        server = s
        pool.execute {
            while (!s.isClosed) {
                val c = try { s.accept() } catch (_: Exception) { break }
                pool.execute { runCatching { serve(c) }.onFailure { Log.w(TAG, "p2p: ${it.message}") }; runCatching { c.close() } }
            }
        }
    }

    private class Req(val method: String, val path: String, val query: Map<String, String>, val headers: Map<String, String>, val body: InputStream)

    private fun readReq(input: InputStream): Req? {
        fun line(): String? {
            val sb = StringBuilder()
            while (true) {
                val b = input.read()
                if (b < 0) return if (sb.isEmpty()) null else sb.toString()
                if (b == '\n'.code) return sb.toString().trimEnd('\r')
                sb.append(b.toChar())
                if (sb.length > 8192) return null
            }
        }
        val first = line() ?: return null
        val parts = first.split(' ')
        if (parts.size < 2) return null
        val headers = mutableMapOf<String, String>()
        while (true) {
            val l = line() ?: break
            if (l.isEmpty()) break
            headers[l.substringBefore(':').trim().lowercase()] = l.substringAfter(':', "").trim()
        }
        val raw = parts[1]
        val dec = { s: String -> runCatching { URLDecoder.decode(s, "UTF-8") }.getOrDefault(s) }
        val path = dec(raw.substringBefore('?'))
        val query = raw.substringAfter('?', "").split('&').filter { it.contains('=') }.associate { dec(it.substringBefore('=')) to dec(it.substringAfter('=')) }
        return Req(parts[0], path, query, headers, input)
    }

    private val REASON = mapOf(200 to "OK", 206 to "Partial Content", 302 to "Found", 400 to "Bad Request", 401 to "Unauthorized", 404 to "Not Found", 416 to "Range Not Satisfiable", 500 to "Error")
    private fun head(out: OutputStream, code: Int, type: String, len: Long, extra: Map<String, String> = emptyMap()) {
        val sb = StringBuilder("HTTP/1.1 $code ${REASON[code] ?: "OK"}\r\nContent-Type: $type\r\nConnection: close\r\nCache-Control: no-store\r\n")
        if (len >= 0) sb.append("Content-Length: $len\r\n")
        extra.forEach { (k, v) -> sb.append("$k: $v\r\n") }
        sb.append("\r\n")
        out.write(sb.toString().toByteArray())
    }
    private fun text(out: OutputStream, code: Int, type: String, s: String) {
        val b = s.toByteArray()
        head(out, code, "$type; charset=utf-8", b.size.toLong())
        out.write(b)
    }

    private fun serve(c: Socket) {
        c.soTimeout = 60000
        val input = BufferedInputStream(c.getInputStream())
        val out = c.getOutputStream().buffered(1 shl 16)
        val r = readReq(input) ?: return
        val who = c.inetAddress.hostAddress ?: ""
        // DropWave on the other phone, after joining DropWave Wi-Fi with the QR: only people with
        // the Wi-Fi password get here, so it may learn the link.
        if (r.method == "GET" && r.path == "/p2p/hello" && mode == "hotspot") {
            text(out, 200, "application/json", JSObject().put("app", "dropwave").put("token", token).put("from", deviceName()).put("pin", pin.isNotEmpty()).toString())
            out.flush(); return
        }
        // DropWave on another phone found this one on the Wi-Fi: ask the person here, then give the link.
        if (r.method == "GET" && r.path == "/p2p/knock" && token.isNotEmpty()) {
            val gid = r.query["gid"].orEmpty().take(80)
            val name = r.query["name"]?.take(40)?.ifBlank { null } ?: "A phone"
            if (gid.isEmpty()) { text(out, 400, "application/json", "{}"); out.flush(); return }
            val ok = approve(gid, name, "see", items.size)
            if (ok) { guests[who] = name; DropWavePlugin.emitOnly("p2p", JSObject().put("type", "guest")) }
            text(out, if (ok) 200 else 403, "application/json", JSObject().put("ok", ok).put("from", deviceName()).apply { if (ok) put("token", token).put("pin", pin) }.toString())
            out.flush(); return
        }
        val prefix = "/s/$token/"
        if (token.isEmpty() || !(r.path == "/s/$token" || r.path.startsWith(prefix))) {
            text(out, 404, "text/html", "<meta name=viewport content='width=device-width'><p style='font:18px system-ui,sans-serif;padding:24px'>This share has ended. Ask for a new QR code.</p>")
            out.flush(); return
        }
        val sub = r.path.removePrefix("/s/$token").trimStart('/')
        if (r.method == "GET" && sub.isEmpty()) {
            if (r.path == "/s/$token") head(out, 302, "text/plain", 0, mapOf("Location" to prefix))
            else { val html = app.assets.open("public/guest.html").use { it.readBytes() }; head(out, 200, "text/html; charset=utf-8", html.size.toLong()); out.write(html) }
            out.flush(); return
        }
        if (r.method == "GET" && sub == "font.woff2") {
            val f = runCatching { app.assets.open("public/fonts/jakarta.woff2").use { it.readBytes() } }.getOrNull()
            if (f == null) text(out, 404, "text/plain", "No font") else { head(out, 200, "font/woff2", f.size.toLong(), mapOf("Cache-Control" to "max-age=86400")); out.write(f) }
            out.flush(); return
        }
        // Everything else needs the PIN when one is set.
        if (pin.isNotEmpty() && r.query["pin"] != pin && r.headers["x-pin"] != pin) {
            text(out, 401, "application/json", "{\"pin\":true}")
            out.flush(); return
        }
        when {
            r.method == "GET" && sub == "info" -> {
                val name = r.query["name"]?.take(40)?.ifBlank { null }
                if (guests.put(who, name ?: guests[who] ?: "Phone ${guests.size + 1}") == null || name != null) DropWavePlugin.emitOnly("p2p", JSObject().put("type", "guest"))
                text(out, 200, "application/json", JSObject().put("from", deviceName()).put("items", itemsJson()).toString())
            }
            r.method == "GET" && sub.startsWith("f/") -> sendFile(out, r, sub.removePrefix("f/").substringBefore('/').toIntOrNull(), who)
            sub == "ask" -> ask(out, r, who)
            r.method == "POST" && sub == "up" -> {
                if (!allowed(r.query["gid"].orEmpty())) text(out, 403, "application/json", "{\"ask\":true}")
                else receive(out, r, who)
            }
            else -> text(out, 404, "text/plain", "Not found")
        }
        out.flush()
    }

    private fun open(it: Item): InputStream? = it.file?.inputStream() ?: it.uri?.let { u -> app.contentResolver.openInputStream(u) }

    private fun sendFile(out: OutputStream, r: Req, i: Int?, who: String) {
        val it = i?.let { id -> items.firstOrNull { x -> x.id == id } } ?: return text(out, 404, "text/plain", "That file is no longer shared")
        val input = open(it) ?: return text(out, 404, "text/plain", "Couldn’t open the file")
        input.use { inp ->
            val size = it.size
            var start = 0L
            var end = size - 1
            val range = r.headers["range"]
            val disp = "attachment; filename*=UTF-8''" + URLEncoder.encode(it.name, "UTF-8").replace("+", "%20")
            if (range != null && size > 0 && range.startsWith("bytes=")) {
                val p = range.removePrefix("bytes=").substringBefore(',').split('-')
                start = p.getOrElse(0) { "" }.toLongOrNull() ?: 0L
                end = p.getOrElse(1) { "" }.toLongOrNull()?.coerceAtMost(size - 1) ?: (size - 1)
                if (start > end) return text(out, 416, "text/plain", "Bad range")
                var skip = start
                while (skip > 0) { val n = inp.skip(skip); if (n <= 0) break; skip -= n }
                head(out, 206, it.mime, end - start + 1, mapOf("Content-Range" to "bytes $start-$end/$size", "Accept-Ranges" to "bytes", "Content-Disposition" to disp))
            } else head(out, 200, it.mime, size, mapOf("Accept-Ranges" to "bytes", "Content-Disposition" to disp))
            val total = if (size >= 0) end - start + 1 else -1L
            val buf = ByteArray(1 shl 16)
            var left = if (total >= 0) total else Long.MAX_VALUE
            var done = 0L
            var last = 0L
            val guest = guests[who] ?: "Phone"
            fun tell(type: String) = DropWavePlugin.emitOnly("p2p", JSObject().put("type", type).put("i", i).put("name", it.name).put("done", start + done).put("total", size).put("guest", guest).put("sentBytes", sentBytes))
            while (left > 0) {
                val n = inp.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
                if (n <= 0) break
                out.write(buf, 0, n)
                left -= n; done += n; sentBytes += n
                val now = System.currentTimeMillis()
                if (now - last > 300) { last = now; tell("progress") }
            }
            out.flush()
            if (start + done >= size) tell("sent")
        }
    }

    /** "May I send you these?" Waits up to 2 minutes for the person here. */
    private fun ask(out: OutputStream, r: Req, who: String) {
        val gid = r.query["gid"].orEmpty().take(80)
        val name = (r.query["name"]?.take(40)?.ifBlank { null } ?: guests[who] ?: "A phone")
        if (gid.isEmpty()) return text(out, 400, "application/json", "{\"ok\":false}")
        val ok = approve(gid, name, "send", r.query["count"]?.toIntOrNull() ?: 1, r.query["bytes"]?.toLongOrNull() ?: -1L, r.query["names"].orEmpty().take(400))
        text(out, if (ok) 200 else 403, "application/json", "{\"ok\":$ok}")
    }

    /** Asks the person here (sheet + notification), unless this phone is trusted or was allowed lately. kind: send | see */
    private fun approve(gid: String, name: String, kind: String, count: Int = 0, bytes: Long = -1L, names: String = ""): Boolean {
        if (allowed(gid)) return true
        val id = randomToken()
        val f = java.util.concurrent.CompletableFuture<Boolean>()
        asks[id] = f
        DropWavePlugin.emitOnly("p2p", JSObject().put("type", "ask").put("kind", kind).put("id", id).put("gid", gid).put("name", name)
            .put("count", count).put("bytes", bytes).put("names", names))
        Notifs.askToReceive(app, name, count, kind == "see")
        val ok = runCatching { f.get(120, java.util.concurrent.TimeUnit.SECONDS) }.getOrDefault(false)
        asks.remove(id)
        DropWavePlugin.emitOnly("p2p", JSObject().put("type", "asked").put("id", id))
        return ok
    }

    // ---------- found on the Wi-Fi without a QR (DropWave on both phones) ----------
    private var nsdReg: android.net.nsd.NsdManager.RegistrationListener? = null
    private fun announce() {
        val nsd = app.getSystemService(android.net.nsd.NsdManager::class.java) ?: return
        val info = android.net.nsd.NsdServiceInfo().apply {
            serviceName = deviceName().take(40); serviceType = "_dwp2p._tcp"; port = PORT
            setAttribute("id", myId(app).take(36)); setAttribute("n", items.size.toString())
        }
        val l = object : android.net.nsd.NsdManager.RegistrationListener {
            override fun onServiceRegistered(i: android.net.nsd.NsdServiceInfo) { Log.i(TAG, "p2p: announced as ${i.serviceName}") }
            override fun onRegistrationFailed(i: android.net.nsd.NsdServiceInfo, e: Int) { Log.w(TAG, "p2p: announce failed $e") }
            override fun onServiceUnregistered(i: android.net.nsd.NsdServiceInfo) {}
            override fun onUnregistrationFailed(i: android.net.nsd.NsdServiceInfo, e: Int) {}
        }
        runCatching { nsd.registerService(info, android.net.nsd.NsdManager.PROTOCOL_DNS_SD, l); nsdReg = l }
    }
    private fun unannounce() {
        val l = nsdReg ?: return
        nsdReg = null
        runCatching { app.getSystemService(android.net.nsd.NsdManager::class.java)?.unregisterService(l) }
    }

    /** A file from the other phone: saved where its type belongs (photos in the Gallery). */
    private fun receive(out: OutputStream, r: Req, who: String) {
        val name = MediaSaver.cleanName(r.query["name"])
        val len = r.headers["content-length"]?.toLongOrNull() ?: return text(out, 400, "text/plain", "Missing length")
        val guest = guests[who] ?: "Phone"
        try {
            val uri = MediaSaver.save(app, name, len, r.body) { d ->
                DropWavePlugin.emitOnly("p2p", JSObject().put("type", "receiving").put("name", name).put("done", d).put("total", len).put("guest", guest))
            }
            val o = JSObject().put("name", name).put("size", len).put("uri", uri.toString()).put("at", System.currentTimeMillis())
                .put("from", guest).put("folder", MediaSaver.folderFor(MediaSaver.mimeOf(name)))
            received.add(o)
            DropWavePlugin.emitOnly("p2p", JSObject().put("type", "received").put("name", name).put("size", len).put("uri", uri.toString()).put("guest", guest).put("folder", o.getString("folder")))
            text(out, 200, "application/json", "{\"ok\":true}")
        } catch (e: Exception) {
            text(out, 500, "text/plain", e.message ?: "Failed")
        }
    }

    fun deviceName(): String {
        val maker = Build.MANUFACTURER.orEmpty()
        val model = Build.MODEL.orEmpty()
        return if (maker.isNotEmpty() && !model.lowercase().startsWith(maker.lowercase())) "${maker.replaceFirstChar { it.uppercase() }} $model" else model
    }
}

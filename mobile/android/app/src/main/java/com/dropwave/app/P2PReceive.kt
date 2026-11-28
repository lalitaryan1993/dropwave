package com.dropwave.app

import android.app.Activity
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.Uri
import android.net.wifi.WifiNetworkSpecifier
import android.util.Log
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.URL
import java.net.URLEncoder

/**
 * Receiving with DropWave on this phone: scan the other phone's QR in the app. A Wi-Fi QR joins
 * DropWave Wi-Fi by itself (Android asks once), then the share is found on the other phone; a
 * link QR (same Wi-Fi) opens it directly. Files download natively with progress and land where
 * their type belongs (photos in the Gallery, contacts ready to import).
 */
object P2PReceive {
    private var network: Network? = null
    private var callback: ConnectivityManager.NetworkCallback? = null
    private var base = "" // http://ip:port/s/token/
    private var pin = ""
    @Volatile private var cancel = false

    /** Google's QR scanner (no camera permission; Play services). Resolves the raw text. */
    fun scan(activity: Activity, done: (String?, String?) -> Unit) {
        val opts = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).enableAutoZoom().build()
        GmsBarcodeScanning.getClient(activity, opts).startScan()
            .addOnSuccessListener { done(it.rawValue ?: "", null) }
            .addOnCanceledListener { done(null, "cancelled") }
            .addOnFailureListener { done(null, it.message ?: "Couldn’t open the scanner") }
    }

    /** From the scanned text: join the Wi-Fi if needed, then find the share. Calls done(info) or done(null, error). */
    fun connect(ctx: Context, raw: String, done: (JSObject?, String?) -> Unit) {
        leave(ctx)
        pin = ""
        when {
            raw.startsWith("WIFI:", true) -> {
                val f = parseWifi(raw)
                val ssid = f["S"] ?: return done(null, "That QR has no Wi-Fi name")
                joinWifi(ctx, ssid, f["P"].orEmpty()) { net, err ->
                    if (net == null) return@joinWifi done(null, err)
                    network = net
                    Thread {
                        // DropWave Wi-Fi: the sharing phone is the network's gateway.
                        val gw = gateway(ctx, net)
                        val hello = gw?.let { runCatching { getJson(net, "http://$it:${P2P.PORT}/p2p/hello") }.getOrNull() }
                        if (hello == null || hello.optString("app") != "dropwave") {
                            done(JSObject().put("joined", true).put("ssid", ssid).put("dropwave", false), null)
                        } else {
                            base = "http://$gw:${P2P.PORT}/s/${hello.getString("token")}/"
                            done(JSObject().put("joined", true).put("ssid", ssid).put("dropwave", true).put("from", hello.optString("from")).put("pin", hello.optBoolean("pin")), null)
                        }
                    }.start()
                }
            }
            Regex("^https?://[^/]+:${P2P.PORT}/s/[^/]+/?", RegexOption.IGNORE_CASE).containsMatchIn(raw) -> {
                base = Regex("^(https?://[^/]+/s/[^/]+)/?").find(raw)!!.groupValues[1] + "/"
                done(JSObject().put("joined", false).put("dropwave", true).put("from", ""), null)
            }
            else -> done(null, "That isn’t a DropWave code. Scan the code on the other phone’s “Phone to phone” screen.")
        }
    }

    fun setPin(p: String) { pin = p.filter { it.isDigit() }.take(4) }

    // ---------- phones sharing on this Wi-Fi (no QR) ----------
    private var disc: android.net.nsd.NsdManager.DiscoveryListener? = null
    private var mlock: android.net.wifi.WifiManager.MulticastLock? = null
    private val resolving = java.util.concurrent.LinkedBlockingQueue<android.net.nsd.NsdServiceInfo>()
    @Volatile private var resolverBusy = false

    fun nearby(ctx: Context, on: Boolean) {
        val nsd = ctx.getSystemService(android.net.nsd.NsdManager::class.java) ?: return
        disc?.let { runCatching { nsd.stopServiceDiscovery(it) } }; disc = null
        mlock?.takeIf { it.isHeld }?.release(); mlock = null
        if (!on) return
        myIdCache = P2P.myId(ctx)
        mlock = ctx.applicationContext.getSystemService(android.net.wifi.WifiManager::class.java)?.createMulticastLock("DropWave:p2p")?.apply { setReferenceCounted(false); acquire() }
        val l = object : android.net.nsd.NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(t: String) {}
            override fun onDiscoveryStopped(t: String) {}
            override fun onStartDiscoveryFailed(t: String, e: Int) { Log.w(TAG, "p2p: discovery failed $e") }
            override fun onStopDiscoveryFailed(t: String, e: Int) {}
            override fun onServiceFound(i: android.net.nsd.NsdServiceInfo) { resolving.offer(i); nextResolve(nsd) }
            override fun onServiceLost(i: android.net.nsd.NsdServiceInfo) { DropWavePlugin.emitOnly("p2precv", JSObject().put("type", "nearbylost").put("key", i.serviceName)) }
        }
        disc = l
        runCatching { nsd.discoverServices("_dwp2p._tcp", android.net.nsd.NsdManager.PROTOCOL_DNS_SD, l) }
    }

    // Android resolves one service at a time.
    private fun nextResolve(nsd: android.net.nsd.NsdManager) {
        if (resolverBusy) return
        val i = resolving.poll() ?: return
        resolverBusy = true
        @Suppress("DEPRECATION")
        runCatching {
            nsd.resolveService(i, object : android.net.nsd.NsdManager.ResolveListener {
                override fun onResolveFailed(s: android.net.nsd.NsdServiceInfo, e: Int) { resolverBusy = false; nextResolve(nsd) }
                override fun onServiceResolved(s: android.net.nsd.NsdServiceInfo) {
                    resolverBusy = false
                    @Suppress("DEPRECATION") val host = s.host?.hostAddress
                    val id = s.attributes["id"]?.let { String(it) }.orEmpty()
                    if (host != null && host.contains('.') && id != myIdCache) {
                        DropWavePlugin.emitOnly("p2precv", JSObject().put("type", "nearby").put("key", s.serviceName).put("name", s.serviceName)
                            .put("host", host).put("port", s.port).put("count", s.attributes["n"]?.let { String(it).toIntOrNull() } ?: 0))
                    }
                    nextResolve(nsd)
                }
            })
        }.onFailure { resolverBusy = false }
    }
    private var myIdCache = ""

    /** Ask a phone found on the Wi-Fi to let this one in (it may trust this phone already). */
    fun knock(ctx: Context, host: String, port: Int, done: (JSObject?, String?) -> Unit) {
        leave(ctx)
        cancel = false
        Thread {
            try {
                val c = (URL("http://$host:$port/p2p/knock?gid=" + URLEncoder.encode(P2P.myId(ctx), "UTF-8") + "&name=" + URLEncoder.encode(P2P.deviceName(), "UTF-8")).openConnection() as HttpURLConnection)
                    .apply { connectTimeout = 6000; readTimeout = 130000 }
                try {
                    if (c.responseCode != 200) return@Thread done(null, "declined")
                    val j = JSONObject(c.inputStream.bufferedReader().readText())
                    base = "http://$host:$port/s/" + j.getString("token") + "/"
                    pin = j.optString("pin")
                    done(JSObject().put("joined", false).put("dropwave", true).put("from", j.optString("from")), null)
                } finally { c.disconnect() }
            } catch (e: Exception) { done(null, e.message ?: "Couldn’t reach that phone") }
        }.start()
    }

    private fun parseWifi(raw: String): Map<String, String> {
        val out = HashMap<String, String>()
        var rest = raw.substringAfter(':')
        while (rest.isNotEmpty()) {
            val key = rest.substringBefore(':')
            if (key == rest) break
            rest = rest.substring(key.length + 1)
            val sb = StringBuilder()
            var k = 0
            while (k < rest.length && rest[k] != ';') { if (rest[k] == '\\' && k + 1 < rest.length) k++; sb.append(rest[k]); k++ }
            out[key.uppercase()] = sb.toString()
            rest = if (k < rest.length) rest.substring(k + 1) else ""
        }
        return out
    }

    private fun joinWifi(ctx: Context, ssid: String, pass: String, done: (Network?, String?) -> Unit) {
        val cm = ctx.getSystemService(ConnectivityManager::class.java) ?: return done(null, "No network service")
        val spec = WifiNetworkSpecifier.Builder().setSsid(ssid).apply { if (pass.isNotEmpty()) setWpa2Passphrase(pass) }.build()
        val req = NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).setNetworkSpecifier(spec).build()
        var answered = false
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(n: Network) { if (!answered) { answered = true; done(n, null) } }
            override fun onUnavailable() { if (!answered) { answered = true; done(null, "Couldn’t join “$ssid”. Move closer and try again.") } }
            override fun onLost(n: Network) { if (n == network) DropWavePlugin.emitOnly("p2precv", JSObject().put("type", "lost")) }
        }
        callback = cb
        try { cm.requestNetwork(req, cb, 60000) } catch (e: Exception) { done(null, e.message ?: "Couldn’t join the Wi-Fi") }
    }

    private fun gateway(ctx: Context, n: Network): String? {
        val cm = ctx.getSystemService(ConnectivityManager::class.java) ?: return null
        val lp = cm.getLinkProperties(n) ?: return null
        lp.routes.firstOrNull { it.isDefaultRoute && it.gateway is Inet4Address }?.gateway?.hostAddress?.let { return it }
        lp.routes.mapNotNull { it.gateway }.filterIsInstance<Inet4Address>().firstOrNull { !it.isAnyLocalAddress }?.hostAddress?.let { return it }
        // Fall back to x.y.z.1 on the hotspot's subnet.
        return lp.linkAddresses.map { it.address }.filterIsInstance<Inet4Address>().firstOrNull()?.hostAddress?.substringBeforeLast('.')?.let { "$it.1" }
    }

    private fun open(url: String): HttpURLConnection =
        ((network?.openConnection(URL(url)) ?: URL(url).openConnection()) as HttpURLConnection).apply {
            connectTimeout = 8000; readTimeout = 30000
            if (pin.isNotEmpty()) setRequestProperty("X-PIN", pin)
        }

    private fun getJson(n: Network?, url: String): JSONObject {
        val c = ((n?.openConnection(URL(url)) ?: URL(url).openConnection()) as HttpURLConnection).apply { connectTimeout = 5000; readTimeout = 8000 }
        try { return JSONObject(c.inputStream.bufferedReader().readText()) } finally { c.disconnect() }
    }

    /** The list of shared files. {pin:true} when a PIN is needed. */
    fun info(name: String): JSObject {
        if (base.isEmpty()) throw Exception("Not connected")
        val c = open(base + "info?name=" + URLEncoder.encode(name, "UTF-8"))
        try {
            if (c.responseCode == 401) return JSObject().put("pin", true)
            if (c.responseCode != 200) throw Exception("The other phone answered ${c.responseCode}")
            val j = JSONObject(c.inputStream.bufferedReader().readText())
            return JSObject().put("from", j.optString("from")).put("items", j.optJSONArray("items") ?: JSArray())
        } finally { c.disconnect() }
    }

    /** Downloads these files one after another; emits "p2precv" progress / file / done events. */
    fun download(ctx: Context, list: List<JSONObject>) {
        cancel = false
        val total = list.sumOf { maxOf(0L, it.optLong("size")) }
        var doneAll = 0L
        val t0 = System.currentTimeMillis()
        var ok = 0
        for (it in list) {
            if (cancel) break
            val i = it.getInt("i")
            val name = it.optString("name", "file")
            try {
                val c = open(base + "f/$i/" + URLEncoder.encode(name, "UTF-8").replace("+", "%20"))
                try {
                    if (c.responseCode != 200) throw Exception("The other phone answered ${c.responseCode}")
                    val len = c.contentLengthLong
                    val before = doneAll
                    val uri = MediaSaver.save(ctx, name, len, c.inputStream) { d ->
                        if (cancel) throw Exception("Cancelled")
                        val all = before + d
                        val secs = maxOf(0.001, (System.currentTimeMillis() - t0) / 1000.0)
                        DropWavePlugin.emitOnly("p2precv", JSObject().put("type", "progress").put("i", i).put("done", d).put("size", len)
                            .put("all", all).put("total", total).put("speed", (all / secs).toLong()))
                    }
                    doneAll = before + maxOf(0L, len)
                    ok++
                    DropWavePlugin.emitOnly("p2precv", JSObject().put("type", "file").put("i", i).put("name", name).put("uri", uri.toString())
                        .put("size", len).put("folder", MediaSaver.folderFor(MediaSaver.mimeOf(name))).put("kind", it.optString("kind")))
                } finally { c.disconnect() }
            } catch (e: Exception) {
                Log.w(TAG, "p2p receive $name: ${e.message}")
                DropWavePlugin.emitOnly("p2precv", JSObject().put("type", "error").put("i", i).put("name", name).put("error", e.message ?: "Failed"))
            }
        }
        DropWavePlugin.emitOnly("p2precv", JSObject().put("type", "done").put("ok", ok).put("count", list.size).put("cancelled", cancel)
            .put("secs", (System.currentTimeMillis() - t0) / 1000.0).put("bytes", doneAll))
    }

    fun stopDownload() { cancel = true }

    /** Send picked files back to the other phone (it is asked first, unless it trusts this phone). */
    fun upload(ctx: Context, uris: List<Uri>) {
        val cr = ctx.contentResolver
        val gid = P2P.myId(ctx)
        val names = uris.map { u -> runCatching { cr.query(u, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null } }.getOrNull() ?: "file" }
        DropWavePlugin.emitOnly("p2precv", JSObject().put("type", "asking").put("count", uris.size))
        val ok = runCatching {
            val c = open(base + "ask?gid=" + URLEncoder.encode(gid, "UTF-8") + "&name=" + URLEncoder.encode(P2P.deviceName(), "UTF-8") +
                "&count=" + uris.size + "&names=" + URLEncoder.encode(names.take(5).joinToString(", "), "UTF-8"))
            c.readTimeout = 130000
            try { c.responseCode == 200 } finally { c.disconnect() }
        }.getOrDefault(false)
        if (!ok) { DropWavePlugin.emitOnly("p2precv", JSObject().put("type", "declined")); return }
        for (u in uris) {
            var name = "file"; var size = -1L
            runCatching { cr.query(u, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME, android.provider.OpenableColumns.SIZE), null, null, null)?.use { c -> if (c.moveToFirst()) { name = c.getString(0) ?: name; if (!c.isNull(1)) size = c.getLong(1) } } }
            try {
                val bytes = if (size < 0) cr.openInputStream(u)?.use { it.readBytes() } else null
                val len = bytes?.size?.toLong() ?: size
                val c = open(base + "up?gid=" + URLEncoder.encode(gid, "UTF-8") + "&name=" + URLEncoder.encode(name, "UTF-8"))
                c.requestMethod = "POST"; c.doOutput = true
                c.setFixedLengthStreamingMode(len)
                c.outputStream.use { o ->
                    (bytes?.inputStream() ?: cr.openInputStream(u))?.use { inp ->
                        val buf = ByteArray(1 shl 16); var d = 0L; var last = 0L
                        while (true) {
                            val n = inp.read(buf); if (n <= 0) break
                            o.write(buf, 0, n); d += n
                            val now = System.currentTimeMillis()
                            if (now - last > 300) { last = now; DropWavePlugin.emitOnly("p2precv", JSObject().put("type", "upprogress").put("name", name).put("done", d).put("size", len)) }
                        }
                    }
                }
                if (c.responseCode != 200) throw Exception("The other phone answered ${c.responseCode}")
                c.disconnect()
                DropWavePlugin.emitOnly("p2precv", JSObject().put("type", "uploaded").put("name", name).put("size", len))
            } catch (e: Exception) {
                DropWavePlugin.emitOnly("p2precv", JSObject().put("type", "uperror").put("name", name).put("error", e.message ?: "Failed"))
            }
        }
    }

    /** Leave DropWave Wi-Fi (Android goes back to the usual Wi-Fi). */
    fun leave(ctx: Context) {
        cancel = true
        callback?.let { cb -> runCatching { ctx.getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(cb) } }
        callback = null; network = null; base = ""
    }

    val connected get() = base.isNotEmpty()

}

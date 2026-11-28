package com.dropwave.app

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.util.Log
import com.getcapacitor.JSObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.math.BigInteger
import java.net.InetSocketAddress
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.X509Certificate
import java.security.interfaces.RSAPublicKey
import java.util.concurrent.Executors
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/**
 * The phone as a remote for Android TV / Google TV, with the same protocol Google's own TV remote
 * uses (nothing to install on the TV). Pairing once: the TV shows a 6-character code that is typed
 * here. The TV and this phone then know each other's certificate; the remote link is TLS on 6466.
 * Messages are length-prefixed protobuf, written by hand below (no protobuf library).
 */
object TvRemote {
    private const val ALIAS = "dropwave_tv_remote"
    private const val PAIR_PORT = 6467
    private const val REMOTE_PORT = 6466
    private val pool = Executors.newCachedThreadPool()
    private val sender = Executors.newSingleThreadExecutor() // keys and text reach the TV in the order they were pressed
    private lateinit var app: Context

    private fun emit(o: JSObject) = DropWavePlugin.emitOnly("tv", o)

    // ---------- tiny protobuf ----------

    private class Pb {
        private val out = ByteArrayOutputStream()
        private fun varint(v: Long) { var x = v; while (true) { if ((x and 0x7FL.inv()) == 0L) { out.write(x.toInt()); return }; out.write(((x and 0x7F) or 0x80).toInt()); x = x ushr 7 } }
        fun int(field: Int, v: Long) = apply { varint((field.toLong() shl 3) or 0); varint(v) }
        fun bytes(field: Int, b: ByteArray) = apply { varint((field.toLong() shl 3) or 2); varint(b.size.toLong()); out.write(b) }
        fun str(field: Int, s: String) = bytes(field, s.toByteArray())
        fun msg(field: Int, m: Pb) = bytes(field, m.toBytes())
        fun toBytes(): ByteArray = out.toByteArray()
    }

    /** field -> values (Long for varints, ByteArray for length-delimited). */
    private fun parse(b: ByteArray): Map<Int, List<Any>> {
        val m = HashMap<Int, MutableList<Any>>()
        var i = 0
        fun varint(): Long { var shift = 0; var r = 0L; while (true) { val x = b[i++].toInt() and 0xFF; r = r or ((x and 0x7F).toLong() shl shift); if ((x and 0x80) == 0) return r; shift += 7 } }
        while (i < b.size) {
            val key = varint(); val f = (key ushr 3).toInt()
            when ((key and 7).toInt()) {
                0 -> m.getOrPut(f) { mutableListOf() }.add(varint())
                2 -> { val n = varint().toInt(); m.getOrPut(f) { mutableListOf() }.add(b.copyOfRange(i, i + n)); i += n }
                1 -> i += 8
                5 -> i += 4
                else -> return m
            }
        }
        return m
    }
    private fun Map<Int, List<Any>>.sub(f: Int) = (this[f]?.firstOrNull() as? ByteArray)?.let { parse(it) }
    private fun Map<Int, List<Any>>.num(f: Int) = (this[f]?.firstOrNull() as? Long) ?: 0L
    private fun Map<Int, List<Any>>.text(f: Int) = (this[f]?.firstOrNull() as? ByteArray)?.let { String(it) }

    private fun send(out: OutputStream, b: ByteArray) {
        val head = ByteArrayOutputStream(); var x = b.size.toLong()
        while (true) { if (x < 0x80) { head.write(x.toInt()); break }; head.write(((x and 0x7F) or 0x80).toInt()); x = x ushr 7 }
        synchronized(out) { out.write(head.toByteArray()); out.write(b); out.flush() }
    }
    private fun read(inp: InputStream): ByteArray {
        var shift = 0; var n = 0L
        while (true) { val x = inp.read(); if (x < 0) throw java.io.EOFException("The TV closed the connection"); n = n or ((x and 0x7F).toLong() shl shift); if ((x and 0x80) == 0) break; shift += 7 }
        val b = ByteArray(n.toInt()); var got = 0
        while (got < b.size) { val r = inp.read(b, got, b.size - got); if (r < 0) throw java.io.EOFException("The TV closed the connection"); got += r }
        return b
    }

    // ---------- this phone's certificate ----------
    // A plain RSA key and a self-signed certificate made here and kept in the app's private storage.
    // (Keys inside Android's hardware key store fail in the TV's TLS handshake on many phones:
    // "RSA routines: internal error".) The certificate is built by hand in DER below.

    private fun der(tag: Int, vararg parts: ByteArray): ByteArray {
        val body = ByteArrayOutputStream().apply { parts.forEach { write(it) } }.toByteArray()
        val n = body.size
        val len = when { n < 0x80 -> byteArrayOf(n.toByte()); n < 0x100 -> byteArrayOf(0x81.toByte(), n.toByte()); n < 0x10000 -> byteArrayOf(0x82.toByte(), (n shr 8).toByte(), n.toByte()); else -> byteArrayOf(0x83.toByte(), (n shr 16).toByte(), (n shr 8).toByte(), n.toByte()) }
        return byteArrayOf(tag.toByte()) + len + body
    }
    private fun oid(vararg arcs: Int): ByteArray {
        val out = ByteArrayOutputStream(); out.write(arcs[0] * 40 + arcs[1])
        for (a in arcs.drop(2)) { val st = ArrayList<Int>(); var v = a; st.add(v and 0x7F); v = v ushr 7; while (v > 0) { st.add((v and 0x7F) or 0x80); v = v ushr 7 }; st.reversed().forEach { out.write(it) } }
        return der(0x06, out.toByteArray())
    }
    private fun selfSigned(kp: java.security.KeyPair): X509Certificate {
        val sha256Rsa = der(0x30, oid(1, 2, 840, 113549, 1, 1, 11), byteArrayOf(0x05, 0x00))
        val name = der(0x30, der(0x31, der(0x30, oid(2, 5, 4, 3), der(0x0C, "DropWave Remote".toByteArray()))))
        val fmt = java.text.SimpleDateFormat("yyMMddHHmmss'Z'", java.util.Locale.US).apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }
        val now = System.currentTimeMillis()
        val validity = der(0x30, der(0x17, fmt.format(java.util.Date(now - 86_400_000L)).toByteArray()), der(0x17, fmt.format(java.util.Date(now + 15L * 365 * 86_400_000L)).toByteArray()))
        val tbs = der(0x30,
            der(0xA0, der(0x02, byteArrayOf(2))), // version 3
            der(0x02, BigInteger.valueOf(now).toByteArray()),
            sha256Rsa, name, validity, name,
            kp.public.encoded) // SubjectPublicKeyInfo
        val sig = java.security.Signature.getInstance("SHA256withRSA").apply { initSign(kp.private); update(tbs) }.sign()
        val cert = der(0x30, tbs, sha256Rsa, der(0x03, byteArrayOf(0) + sig))
        return java.security.cert.CertificateFactory.getInstance("X.509").generateCertificate(cert.inputStream()) as X509Certificate
    }

    private var cachedKs: KeyStore? = null
    private var cachedCert: X509Certificate? = null
    private fun keyStore(): KeyStore {
        cachedKs?.let { return it }
        val p = app.getSharedPreferences("tv", Context.MODE_PRIVATE)
        val b64 = { s: String? -> s?.let { android.util.Base64.decode(it, android.util.Base64.NO_WRAP) } }
        var keyBytes = b64(p.getString("key", null))
        var certBytes = b64(p.getString("cert", null))
        if (keyBytes == null || certBytes == null) {
            val kp = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
            val c = selfSigned(kp)
            keyBytes = kp.private.encoded; certBytes = c.encoded
            p.edit().putString("key", android.util.Base64.encodeToString(keyBytes, android.util.Base64.NO_WRAP))
                .putString("cert", android.util.Base64.encodeToString(certBytes, android.util.Base64.NO_WRAP)).apply()
        }
        val key = java.security.KeyFactory.getInstance("RSA").generatePrivate(java.security.spec.PKCS8EncodedKeySpec(keyBytes))
        val cert = java.security.cert.CertificateFactory.getInstance("X.509").generateCertificate(certBytes!!.inputStream()) as X509Certificate
        val ks = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null, null); setKeyEntry(ALIAS, key, CharArray(0), arrayOf(cert)) }
        cachedKs = ks; cachedCert = cert
        return ks
    }

    private fun connect(host: String, port: Int): SSLSocket {
        val ks = keyStore()
        val kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(ks, CharArray(0)) }
        // The TV's certificate is its own (self-signed); pairing is what makes it trusted.
        val trustAll = arrayOf<TrustManager>(object : X509TrustManager {
            override fun checkClientTrusted(c: Array<out X509Certificate>?, a: String?) {}
            override fun checkServerTrusted(c: Array<out X509Certificate>?, a: String?) {}
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        })
        val ctx = SSLContext.getInstance("TLS").apply { init(kmf.keyManagers, trustAll, null) }
        val s = ctx.socketFactory.createSocket() as SSLSocket
        s.connect(InetSocketAddress(host, port), 6000)
        s.soTimeout = 0
        s.startHandshake()
        return s
    }

    // ---------- TVs on the Wi-Fi ----------

    private var disc: NsdManager.DiscoveryListener? = null
    private var mlock: WifiManager.MulticastLock? = null
    private val toResolve = java.util.concurrent.LinkedBlockingQueue<NsdServiceInfo>()
    @Volatile private var resolving = false

    fun discover(ctx: Context, on: Boolean) {
        app = ctx.applicationContext
        val nsd = ctx.getSystemService(NsdManager::class.java) ?: return
        disc?.let { runCatching { nsd.stopServiceDiscovery(it) } }; disc = null
        mlock?.takeIf { it.isHeld }?.release(); mlock = null
        if (!on) return
        mlock = app.getSystemService(WifiManager::class.java)?.createMulticastLock("DropWave:tv")?.apply { setReferenceCounted(false); acquire() }
        val l = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(t: String) {}
            override fun onDiscoveryStopped(t: String) {}
            override fun onStartDiscoveryFailed(t: String, e: Int) {}
            override fun onStopDiscoveryFailed(t: String, e: Int) {}
            override fun onServiceFound(i: NsdServiceInfo) { toResolve.offer(i); next(nsd) }
            override fun onServiceLost(i: NsdServiceInfo) { emit(JSObject().put("type", "lost").put("name", i.serviceName)) }
        }
        disc = l
        runCatching { nsd.discoverServices("_androidtvremote2._tcp", NsdManager.PROTOCOL_DNS_SD, l) }
    }

    private fun next(nsd: NsdManager) {
        if (resolving) return
        val i = toResolve.poll() ?: return
        resolving = true
        @Suppress("DEPRECATION")
        runCatching {
            nsd.resolveService(i, object : NsdManager.ResolveListener {
                override fun onResolveFailed(s: NsdServiceInfo, e: Int) { resolving = false; next(nsd) }
                override fun onServiceResolved(s: NsdServiceInfo) {
                    resolving = false
                    @Suppress("DEPRECATION") val host = s.host?.hostAddress
                    if (host != null && host.contains('.')) emit(JSObject().put("type", "found").put("name", s.serviceName).put("host", host).put("paired", paired(host)))
                    next(nsd)
                }
            })
        }.onFailure { resolving = false }
    }

    // ---------- saved TVs ----------

    private fun prefs() = app.getSharedPreferences("tv", Context.MODE_PRIVATE)
    fun saved(ctx: Context): org.json.JSONArray { app = ctx.applicationContext; return runCatching { org.json.JSONArray(prefs().getString("tvs", "[]")) }.getOrDefault(org.json.JSONArray()) }
    private fun paired(host: String): Boolean { val a = saved(app); return (0 until a.length()).any { a.getJSONObject(it).optString("host") == host } }
    private fun save(host: String, name: String) {
        val a = saved(app); val out = org.json.JSONArray()
        for (k in 0 until a.length()) if (a.getJSONObject(k).optString("host") != host) out.put(a.getJSONObject(k))
        out.put(org.json.JSONObject().put("host", host).put("name", name).put("at", System.currentTimeMillis()))
        prefs().edit().putString("tvs", out.toString()).apply()
    }
    fun rename(ctx: Context, host: String, name: String) {
        app = ctx.applicationContext
        val a = saved(app)
        for (k in 0 until a.length()) if (a.getJSONObject(k).optString("host") == host) a.getJSONObject(k).put("name", name.take(40))
        prefs().edit().putString("tvs", a.toString()).apply()
    }
    fun forget(ctx: Context, host: String) {
        app = ctx.applicationContext
        val a = saved(app); val out = org.json.JSONArray()
        for (k in 0 until a.length()) if (a.getJSONObject(k).optString("host") != host) out.put(a.getJSONObject(k))
        prefs().edit().putString("tvs", out.toString()).apply()
    }

    // ---------- pairing (port 6467) ----------

    private var pairing: SSLSocket? = null
    private var pairHost = ""
    private var pairName = ""

    // PairingMessage: protocol_version=1, status=2, request=10, request_ack=11, option=20, configuration=30, configuration_ack=31, secret=40, secret_ack=41
    private fun pairMsg(build: Pb.() -> Unit) = Pb().int(1, 2).int(2, 200).apply(build).toBytes()
    private fun pairRead(s: SSLSocket): Map<Int, List<Any>> {
        val m = parse(read(s.inputStream))
        val st = m.num(2)
        if (st != 200L) throw Exception(when (st) { 402L -> "Wrong code. Try again."; 401L -> "The TV refused the pairing settings"; else -> "The TV said no (status $st)" })
        return m
    }

    /** Starts pairing: the TV then shows a code. */
    fun pairStart(ctx: Context, host: String, name: String, done: (String?) -> Unit) {
        app = ctx.applicationContext
        pool.execute {
            try {
                runCatching { pairing?.close() }
                val s = connect(host, PAIR_PORT)
                pairing = s; pairHost = host; pairName = name
                val out = s.outputStream
                send(out, pairMsg { msg(10, Pb().str(1, "atvremote").str(2, "DropWave on ${P2P.deviceName()}")) })
                pairRead(s) // request ack
                val enc = Pb().int(1, 3).int(2, 6) // hexadecimal, 6 symbols
                send(out, pairMsg { msg(20, Pb().msg(1, enc).int(3, 1)) }) // input encodings, preferred role: input
                pairRead(s) // option
                send(out, pairMsg { msg(30, Pb().msg(1, Pb().int(1, 3).int(2, 6)).int(2, 1)) }) // configuration: client is input
                pairRead(s) // configuration ack: the code is on the TV now
                done(null)
            } catch (e: Exception) {
                Log.w(TAG, "tv pair start", e)
                runCatching { pairing?.close() }; pairing = null
                done(e.message ?: "Couldn’t reach the TV")
            }
        }
    }

    private fun hexBytes(n: BigInteger): ByteArray {
        var h = n.toString(16).uppercase()
        if (h.length % 2 == 1) h = "0$h"
        return ByteArray(h.length / 2) { h.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    }

    /** Finishes pairing with the code shown on the TV. */
    fun pairFinish(code: String, done: (String?) -> Unit) {
        pool.execute {
            val s = pairing ?: return@execute done("Start pairing again")
            try {
                val c = code.trim().uppercase().filter { it in "0123456789ABCDEF" }
                if (c.length != 6) return@execute done("The code has 6 letters and numbers")
                val mine = (keyStore().getCertificate(ALIAS).publicKey as RSAPublicKey)
                val theirs = (s.session.peerCertificates[0].publicKey as RSAPublicKey)
                val md = MessageDigest.getInstance("SHA-256")
                md.update(hexBytes(mine.modulus)); md.update(hexBytes(mine.publicExponent))
                md.update(hexBytes(theirs.modulus)); md.update(hexBytes(theirs.publicExponent))
                md.update(ByteArray(2) { c.substring(2 + it * 2, 4 + it * 2).toInt(16).toByte() })
                val hash = md.digest()
                if ((hash[0].toInt() and 0xFF) != c.substring(0, 2).toInt(16)) return@execute done("Wrong code. Check the code on the TV.")
                send(s.outputStream, pairMsg { msg(40, Pb().bytes(1, hash)) })
                pairRead(s) // secret ack
                save(pairHost, pairName)
                runCatching { s.close() }; pairing = null
                done(null)
            } catch (e: Exception) {
                Log.w(TAG, "tv pair finish", e)
                done(e.message ?: "Pairing failed")
            }
        }
    }

    // ---------- the remote (port 6466) ----------

    private var sock: SSLSocket? = null
    private var host = ""
    @Volatile private var imeCounter = 0L
    @Volatile private var fieldCounter = 0L

    fun open(ctx: Context, h: String, done: (String?) -> Unit) {
        app = ctx.applicationContext
        close()
        pool.execute {
            val s = try { connect(h, REMOTE_PORT) } catch (e: Exception) {
                Log.w(TAG, "tv connect", e)
                return@execute done(if (e is javax.net.ssl.SSLException) "pair" else (e.message ?: "Couldn’t reach the TV"))
            }
            sock = s; host = h
            done(null)
            emit(JSObject().put("type", "connected").put("host", h))
            try {
                val out = s.outputStream
                while (true) {
                    val m = parse(read(s.inputStream))
                    when {
                        m.containsKey(1) -> send(out, Pb().msg(1, Pb().int(1, 622).msg(2, Pb().str(1, Build.MODEL).str(2, Build.MANUFACTURER).int(3, 1).str(4, "1").str(5, "atvremote").str(6, "1.0.0"))).toBytes())
                        m.containsKey(2) -> send(out, Pb().msg(2, Pb().int(1, 622)).toBytes())
                        m.containsKey(8) -> send(out, Pb().msg(9, Pb().int(1, m.sub(8)?.num(1) ?: 0)).toBytes())
                        m.containsKey(40) -> emit(JSObject().put("type", "power").put("on", m.sub(40)?.num(1) == 1L))
                        m.containsKey(50) -> m.sub(50)?.let { v -> emit(JSObject().put("type", "volume").put("level", v.num(7)).put("max", v.num(6)).put("muted", v.num(8) == 1L)) }
                        m.containsKey(20) -> m.sub(20)?.sub(1)?.text(12)?.let { emit(JSObject().put("type", "app").put("pkg", it)) }
                        m.containsKey(21) -> m.sub(21)?.let { e -> imeCounter = e.num(1); fieldCounter = e.num(2); emit(JSObject().put("type", "ime").put("on", true)) }
                        m.containsKey(22) -> emit(JSObject().put("type", "ime").put("on", (m.sub(22)?.sub(2)?.num(1) ?: 1L) != 0L))
                        m.containsKey(3) -> Log.w(TAG, "tv remote error")
                    }
                }
            } catch (e: Exception) {
                Log.i(TAG, "tv remote closed: ${e.message}")
            } finally {
                if (sock === s) { sock = null; emit(JSObject().put("type", "disconnected").put("host", h)) }
                runCatching { s.close() }
            }
        }
    }

    fun close() { val s = sock; sock = null; runCatching { s?.close() } }

    private fun out(): OutputStream = sock?.outputStream ?: throw Exception("Not connected to the TV")

    /** direction: 3 short press, 1 start long press, 2 end long press. */
    fun key(code: Int, direction: Int = 3) { val o = out(); sender.execute { runCatching { send(o, Pb().msg(10, Pb().int(1, code.toLong()).int(2, direction.toLong())).toBytes()) } } }

    /** Types into the text box on the TV (replaces what's in it). */
    fun text(s: String) {
        val o = out()
        sender.execute {
            runCatching {
                val edit = Pb().int(1, 1).msg(2, Pb().int(1, (s.length - 1).toLong().coerceAtLeast(0)).int(2, (s.length - 1).toLong().coerceAtLeast(0)).str(3, s))
                send(o, Pb().msg(21, Pb().int(1, imeCounter).int(2, fieldCounter).msg(3, edit)).toBytes())
            }
        }
    }

    /** Opens an app on the TV by its link (https://www.youtube.com, https://www.netflix.com/title…, market://launch?id=…). */
    fun launch(link: String) { val o = out(); sender.execute { runCatching { send(o, Pb().msg(90, Pb().str(1, link)).toBytes()) } } }

    val connected get() = sock != null
}

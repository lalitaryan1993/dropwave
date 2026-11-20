package com.dropwave.app

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.os.BatteryManager
import android.os.Build
import android.util.Log
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.ssl.HttpsURLConnection
import kotlin.concurrent.thread
import kotlin.math.roundToInt

/**
 * DropWave's own line to the PC, in native code, so the phone keeps answering while it's locked
 * or another app is open (Android puts the page to sleep then, but not this foreground app).
 *
 * The page stays in charge while it's awake: every PC command carries an id, and whoever claims
 * it first handles it. The page claims at once; this side waits a moment and handles what the
 * page didn't. Same for news from the phone (calls, SMS, notifications, battery): when the page
 * doesn't answer a quick probe, this side tells the PC itself.
 */
object Link {
    private const val TAG = "DropWave"
    data class Config(val base: String, val key: String, val id: String, val name: String)

    @Volatile private var cfg: Config? = null
    @Volatile private var gen = 0
    private lateinit var app: Context
    private val work = Executors.newSingleThreadScheduledExecutor()
    private val claimed = LinkedHashSet<String>()
    @Volatile private var pageSeen = 0L // last time the page claimed something (it's awake)
    private val sentIcons = HashSet<String>()
    private var probeN = 0

    // ---------- setup (from the page) ----------

    fun start(ctx: Context, c: Config) {
        app = ctx.applicationContext
        if (c == cfg) return
        cfg = c
        val g = ++gen
        thread(name = "dw-link", isDaemon = true) { loop(g) }
    }

    fun stop() { cfg = null; gen++ }

    /** The page or this side takes a command / event. First one wins. */
    fun claim(id: String, byPage: Boolean): Boolean = synchronized(claimed) {
        if (byPage) pageSeen = System.currentTimeMillis()
        if (!claimed.add(id)) return false
        if (claimed.size > 500) claimed.remove(claimed.first())
        true
    }

    private fun pageAwake() = System.currentTimeMillis() - pageSeen < 4000

    // ---------- share switches (DropWave › Privacy), copied here by the page ----------

    private fun shareJson(): JSONObject = runCatching { JSONObject(Access.prefs(app).getString("share", "{}")!!) }.getOrDefault(JSONObject())
    fun setShare(ctx: Context, json: String) { Access.prefs(ctx).edit().putString("share", json).apply() }
    private val SHARE_KEYS = listOf("notifs", "clip", "photos", "calls", "sms", "contacts", "files", "apps", "controls", "camera", "mirror", "ring")
    private fun on(k: String): Boolean { val s = shareJson(); return !s.optBoolean("paused", false) && s.optBoolean(k, true) }

    // ---------- the stream from the PC ----------

    private fun open(path: String): HttpURLConnection {
        val c = cfg!!
        val conn = URL(c.base + path).openConnection() as HttpURLConnection
        if (conn is HttpsURLConnection) {
            conn.sslSocketFactory = Pins.socketFactory(app)
            conn.setHostnameVerifier { _, _ -> true } // identity = pinned certificate
        }
        conn.setRequestProperty("X-DropWave-Key", c.key)
        conn.setRequestProperty("User-Agent", "DropWave Android (${Build.MODEL})")
        return conn
    }

    private fun loop(g: Int) {
        var wait = 2000L
        while (g == gen && cfg != null) {
            val c = cfg ?: break
            try {
                val enc = { s: String -> URLEncoder.encode(s, "UTF-8") }
                val conn = open("/api/events?id=${enc(c.id)}&name=${enc(c.name)}")
                conn.connectTimeout = 10000
                conn.readTimeout = 45000 // the PC pings every 15 s
                BufferedReader(InputStreamReader(conn.inputStream, Charsets.UTF_8)).use { r ->
                    wait = 2000L
                    var event = ""
                    val data = StringBuilder()
                    while (g == gen) {
                        val line = r.readLine() ?: break
                        when {
                            line.isEmpty() -> {
                                if (event == "phone" && data.isNotEmpty()) {
                                    val cmd = runCatching { JSObject(data.toString()) }.getOrNull()
                                    if (cmd != null) onCommand(cmd)
                                }
                                event = ""; data.setLength(0)
                            }
                            line.startsWith("event:") -> event = line.substring(6).trim()
                            line.startsWith("data:") -> data.append(line.substring(5).trim())
                        }
                    }
                }
                conn.disconnect()
            } catch (e: Exception) {
                Log.i(TAG, "link: ${e.message}")
            }
            if (g != gen) break
            Thread.sleep(wait)
            wait = (wait * 2).coerceAtMost(30000L)
        }
    }

    /** Tell the PC something (POST /api/phone). */
    fun post(type: String, data: Any?) {
        val c = cfg ?: return
        try {
            val body = JSONObject().put("from", c.id).put("type", type).put("data", data ?: JSONObject.NULL).toString().toByteArray()
            val conn = open("/api/phone")
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.connectTimeout = 10000
            conn.readTimeout = 20000
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setFixedLengthStreamingMode(body.size)
            conn.outputStream.use { it.write(body) }
            conn.responseCode
            conn.disconnect()
        } catch (e: Exception) {
            Log.i(TAG, "link post $type: ${e.message}")
        }
    }

    // ---------- commands the page didn't take ----------

    private fun onCommand(cmd: JSObject) {
        val cid = cmd.optString("cid", "")
        if (cid.isEmpty()) return // an older PC: the page handles everything
        val delay = if (pageAwake() || DropWavePlugin.isOnScreen()) 1500L else 900L
        work.schedule({
            if (!claim(cid, false)) return@schedule
            try { handle(cmd) } catch (e: Exception) { Log.w(TAG, "link ${cmd.optString("type")}", e) }
        }, delay, TimeUnit.MILLISECONDS)
    }

    private val NEEDS = mapOf(
        "ring" to "ring", "media" to "notifs", "notif" to "notifs", "clip" to "clip", "photos" to "photos", "photo-get" to "photos",
        "call" to "calls", "dial" to "calls", "calllog" to "calls", "sms-threads" to "sms", "sms-thread" to "sms", "sms-send" to "sms",
        "files-list" to "files", "files-get" to "files", "mirror-start" to "mirror", "camera" to "camera", "app-apk" to "apps",
        "webcam-start" to "camera", "webcam-set" to "camera",
    )

    private fun strs(o: JSObject, k: String): List<String> = o.optJSONArray(k)?.let { a -> (0 until a.length()).map { a.optString(it) } }.orEmpty()

    private fun handle(c: JSObject) {
        val type = c.optString("type")
        if (type == "rpc") return rpc(c)
        NEEDS[type]?.let { if (!on(it)) { post("blocked", JSObject().put("type", type).put("what", it).put("purpose", c.opt("purpose") ?: JSONObject.NULL)); return } }
        val k = cfg ?: return
        when (type) {
            "ring" -> if (c.optBoolean("on", true)) Ringer.start(app) else Ringer.stop(app)
            "media" -> PhoneListener.instance?.mediaControl(c.optString("action"), c.optDouble("pos", 0.0))
            "volume" -> { volume(c.optString("action"), c.optInt("value")); post("status", status()) }
            "notif" -> PhoneListener.instance?.act(c.optString("key"), c.optString("action"), c.optInt("i"), c.optString("text"))
            "clip" -> app.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("DropWave", c.optString("text")))
            "call" -> Calls.act(app, c.optString("action"))
            "dial" -> Calls.dial(app, c.optString("number"))?.let { post("dial-error", JSObject().put("error", it)) }
            "calllog" -> post("calllog", JSObject().put("list", Calls.log(app, 50)).put("access", Calls.access(app)))
            "sms-threads" -> post("sms-threads", try { JSObject().put("list", Sms.threads(app, 80)).put("access", Sms.access(app)) } catch (e: Exception) { JSObject().put("error", e.message) })
            "sms-thread" -> {
                val id = c.optLong("thread", -1)
                post("sms-thread", try { JSObject().put("thread", id).put("messages", Sms.thread(app, id, 150)) } catch (e: Exception) { JSObject().put("thread", id).put("error", e.message) })
            }
            "sms-send" -> {
                val err = Sms.send(app, c.optString("to"), c.optString("text"))
                post("sms-sent", JSObject().put("to", c.optString("to")).put("ref", c.opt("ref") ?: JSONObject.NULL).put("ok", err == null).put("error", err))
            }
            "files-list" -> post("files", try {
                if (PhoneFiles.access() != "all") JSObject().put("access", "none")
                else PhoneFiles.list(c.optString("path"), c.optBoolean("hidden")).put("access", "all")
            } catch (e: Exception) { JSObject().put("path", c.optString("path")).put("error", e.message) })
            "files-get" -> PhoneFiles.upload(app, strs(c, "paths").take(500), k.base, k.key, c.optString("token"), k.id) { _, _ -> }
            "photos" -> {
                val purpose = c.opt("purpose") ?: JSONObject.NULL
                post("photos", try {
                    if (PhotoLibrary.access(app) == "none") JSObject().put("access", "none").put("items", JSArray()).put("purpose", purpose)
                    else PhotoLibrary.page(app, c.optInt("offset"), c.optInt("limit", 60).coerceIn(1, 300), c.optString("kind", "all"), c.optLong("after", 0), c.optBoolean("thumbs", true))
                        .put("access", PhotoLibrary.access(app)).put("purpose", purpose)
                } catch (e: Exception) { JSObject().put("error", e.message).put("offset", c.optInt("offset")).put("kind", c.optString("kind")).put("purpose", purpose) })
            }
            "photo-get" -> PhotoLibrary.upload(app, strs(c, "ids").take(500), k.base, k.key, c.optString("token"), k.id) { _, _ -> }
            "camera" -> {
                val video = c.optString("mode") == "video"
                CameraActivity.pending = CameraActivity.Request(k.base, k.key, c.optString("token"), k.id, video)
                val r = Launch.openOrNotify(app, Intent(app, CameraActivity::class.java), false,
                    if (video) "Your PC wants a video" else "Your PC wants a photo", "Tap to open the camera. It goes straight to the PC.")
                post("camera", JSObject().put("opened", r))
            }
            "app-apk" -> {
                val a = Apps.apk(app, c.optString("pkg"))
                if (a == null) post("apk", JSObject().put("pkg", c.optString("pkg")).put("error", "This app is split into parts, so it can’t be copied as one APK"))
                else Upload.file(app, a.first, a.second, "0", k.base, k.key, c.optString("token"), k.id)
            }
            "mirror-start" -> {
                MirrorService.pending = MirrorService.Request(k.base, k.key, c.optString("token"), k.id)
                Launch.openOrNotify(app, Intent(app, MirrorConsentActivity::class.java), false, "Your PC wants to see this screen", "Tap to start showing it on the PC")
            }
            "mirror-stop" -> { MirrorService.pending = null; MirrorService.stop(app) }
            "webcam-start" -> WebcamService.ask(app, WebcamService.Request(k.base, k.key, c.optString("token"), k.id, c.optBoolean("front")), false)
                .let { post("webcam", JSObject().put("asked", it)) }
            "webcam-stop" -> { WebcamService.pending = null; WebcamService.stop(app) }
            "webcam-set" -> WebcamService.instance?.let { s -> if (c.has("front")) s.switchCamera(c.optBoolean("front")); if (c.has("torch")) s.setTorch(c.optBoolean("torch")) }
        }
    }

    private fun rpc(c: JSObject) {
        val rid = c.optString("rid")
        val a = c.optJSONObject("args") ?: JSONObject()
        val need = mapOf("contacts" to "contacts", "contactPhoto" to "contacts", "apps" to "apps", "appIcons" to "apps", "appAction" to "apps", "controls" to "controls", "controlsSet" to "controls")
        val m = c.optString("method")
        val sw = need[m] ?: return post("rpc", JSObject().put("rid", rid).put("error", "This phone’s DropWave needs an update for that"))
        if (!on(sw)) return post("rpc", JSObject().put("rid", rid).put("error", "blocked").put("what", sw))
        try {
            val result: JSObject = when (m) {
                "contacts" -> if (Access.group(app, "contacts") != "all") throw Exception("Allow contacts on the phone first (DropWave › Privacy)") else Contacts.list(app)
                "contactPhoto" -> JSObject().put("data", Contacts.photo(app, a.optLong("id")) ?: JSONObject.NULL)
                "apps" -> Apps.list(app)
                "appIcons" -> {
                    val out = JSObject()
                    a.optJSONArray("pkgs")?.let { p -> for (i in 0 until minOf(p.length(), 40)) { val pkg = p.optString(i); out.put(pkg, PhoneListener.icon(app, pkg) ?: JSONObject.NULL) } }
                    JSObject().put("icons", out)
                }
                "appAction" -> {
                    val pkg = a.optString("pkg"); val name = Apps.label(app, pkg)
                    val r = when (a.optString("action")) {
                        "open" -> Launch.openOrNotify(app, Apps.openIntent(app, pkg) ?: throw Exception("That app can’t be opened"), false, "Open $name", "Your PC wants to open $name. Tap to open it.")
                        "info" -> Launch.openOrNotify(app, Apps.infoIntent(pkg), false, "$name: app info", "Tap to see $name in Android settings")
                        "uninstall" -> Launch.openOrNotify(app, Apps.uninstallIntent(pkg), false, "Uninstall $name?", "Your PC asked to uninstall $name. Tap to confirm on the phone.")
                        else -> throw Exception("Unknown action")
                    }
                    JSObject().put("result", r)
                }
                "controls" -> PhoneControls.state(app)
                "controlsSet" -> {
                    val v = a.opt("value")
                    PhoneControls.set(app, a.optString("what"), if (v is JSONObject) JSObject.fromJSONObject(v) else v, false)
                }
                else -> JSObject()
            }
            post("rpc", JSObject().put("rid", rid).put("result", result))
        } catch (e: Exception) {
            post("rpc", JSObject().put("rid", rid).put("error", e.message ?: "Couldn’t do that"))
        }
    }

    private fun volume(action: String, value: Int) {
        val am = app.getSystemService(AudioManager::class.java)
        val s = AudioManager.STREAM_MUSIC
        runCatching {
            when (action) {
                "up" -> am.adjustStreamVolume(s, AudioManager.ADJUST_RAISE, 0)
                "down" -> am.adjustStreamVolume(s, AudioManager.ADJUST_LOWER, 0)
                "mute" -> am.adjustStreamVolume(s, AudioManager.ADJUST_TOGGLE_MUTE, 0)
                "set" -> {
                    val v = value.coerceIn(0, am.getStreamMaxVolume(s))
                    if (am.isStreamMute(s) && v > 0) am.adjustStreamVolume(s, AudioManager.ADJUST_UNMUTE, 0)
                    am.setStreamVolume(s, v, 0)
                }
            }
        }
    }

    // ---------- news from the phone while the page sleeps ----------

    /** Called for every event the plugin passes to the page. */
    fun onEvent(event: String, data: JSObject) {
        if (cfg == null || !::app.isInitialized) return
        val kinds = setOf("phoneNotifs", "phoneMedia", "battery", "volume", "access", "call", "appcall", "sms", "controls", "mirror", "camera", "webcam")
        if (event !in kinds || pageAwake()) return
        val n = synchronized(claimed) { ++probeN }
        val id = "ev$n"
        DropWavePlugin.emitOnly("linkProbe", JSObject().put("id", id)) // an awake page claims it and sends the news itself
        work.schedule({
            if (!claim(id, false)) return@schedule
            try { push(event, data) } catch (e: Exception) { Log.w(TAG, "link push $event", e) }
        }, 1000, TimeUnit.MILLISECONDS)
    }

    private fun push(event: String, d: JSObject) {
        when (event) {
            "phoneNotifs" -> {
                if (!on("notifs")) return post("notifs", JSObject().put("list", JSArray()))
                val list = d.optJSONArray("list") ?: PhoneListener.instance?.snapshot() ?: JSArray()
                post("notifs", JSObject().put("list", list))
                for (i in 0 until list.length()) {
                    val pkg = list.optJSONObject(i)?.optString("pkg") ?: continue
                    if (sentIcons.add(pkg)) PhoneListener.icon(app, pkg)?.let { post("icon", JSObject().put("pkg", pkg).put("data", it)) }
                }
            }
            "phoneMedia" -> post("media", if (on("notifs")) d.opt("media") else null)
            "battery", "volume", "access" -> post("status", status())
            "call", "appcall" -> if (on("calls")) post(event, d)
            "sms" -> if (on("sms")) post("sms", d)
            "controls" -> if (on("controls")) post("controls", d)
            "mirror", "camera", "webcam" -> post(event, d)
        }
    }

    /** Same as the page's status message, with what's switched off in Privacy masked. */
    fun status(): JSObject {
        val b = app.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = b?.let { val l = it.getIntExtra(BatteryManager.EXTRA_LEVEL, -1); val sc = it.getIntExtra(BatteryManager.EXTRA_SCALE, 100); if (l < 0 || sc <= 0) -1 else (l * 100f / sc).roundToInt() } ?: -1
        val st = b?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val am = app.getSystemService(AudioManager::class.java)
        val maker = Build.MANUFACTURER.orEmpty()
        val model = Build.MODEL.orEmpty().let { if (maker.isNotEmpty() && !it.lowercase().startsWith(maker.lowercase())) "${maker.replaceFirstChar { c -> c.uppercase() }} $it" else it }
        val off = JSArray()
        SHARE_KEYS.filter { !on(it) }.forEach { off.put(it) }
        return JSObject()
            .put("battery", level).put("charging", st == BatteryManager.BATTERY_STATUS_CHARGING || st == BatteryManager.BATTERY_STATUS_FULL)
            .put("model", model).put("android", Build.VERSION.RELEASE).put("app", "android")
            .put("volume", am.getStreamVolume(AudioManager.STREAM_MUSIC)).put("volumeMax", am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)).put("muted", am.isStreamMute(AudioManager.STREAM_MUSIC))
            .put("clip", on("clip"))
            .put("notifAccess", PhoneListener.enabled(app) && on("notifs"))
            .put("photosAccess", if (on("photos")) PhotoLibrary.access(app) else "none")
            .put("callsAccess", if (on("calls")) Calls.access(app) else "none")
            .put("smsAccess", if (on("sms")) Sms.access(app) else "none")
            .put("filesAccess", if (on("files")) PhoneFiles.access() else "none")
            .put("controlAccess", ControlService.enabled(app))
            .put("mirroring", MirrorService.running)
            .put("unrestricted", Access.unrestricted(app))
            .put("off", off)
    }
}

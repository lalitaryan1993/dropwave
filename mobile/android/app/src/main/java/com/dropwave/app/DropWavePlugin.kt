package com.dropwave.app

import android.Manifest
import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.media.AudioManager
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.provider.OpenableColumns
import android.provider.Settings
import android.util.Log
import android.view.WindowManager
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File
import java.net.Inet4Address
import java.net.NetworkInterface
import kotlin.math.roundToInt

/**
 * Native side of the DropWave app (the page talks to it as Capacitor.Plugins.DropWave):
 *  - files: download (pinned HTTPS or DownloadManager), "Share → DropWave", local IPs for the scan
 *  - notifications for files/messages from the PC, and the background connection (keepAlive)
 *  - full screen for viewing / controlling a PC
 *  - Phone on PC: battery, volume, notifications (listener), what's playing, clipboard, Find my phone
 * Events to the page: shared, notifAction, battery, volume, clip, ring, phoneNotifs, phoneMedia.
 */
@CapacitorPlugin(name = "DropWave")
class DropWavePlugin : Plugin() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var pendingShare: JSObject? = null
    private var lastBattery = -1
    private var lastCharging = false
    private val receivers = mutableListOf<BroadcastReceiver>()

    override fun load() {
        instance = this
        Notifs.ensureChannels(context)
        PhoneControls.watch(context) { emit("controls", PhoneControls.state(context)) }
        // Battery: tell the page when the level or charging changes.
        register(IntentFilter(Intent.ACTION_BATTERY_CHANGED)) { i ->
            val level = battery(i)
            val charging = charging(i)
            if (level != lastBattery || charging != lastCharging) {
                lastBattery = level; lastCharging = charging
                emit("battery", JSObject().put("battery", level).put("charging", charging))
            }
        }
        // Media volume changed (buttons, another app, or the PC).
        register(IntentFilter("android.media.VOLUME_CHANGED_ACTION").apply { addAction("android.media.STREAM_MUTE_CHANGED_ACTION") }) { i ->
            val stream = i.getIntExtra("android.media.EXTRA_VOLUME_STREAM_TYPE", -1)
            if (stream == -1 || stream == AudioManager.STREAM_MUSIC) emit("volume", volumeState())
        }
        // Calls: ringing / on a call / ended (with the number once the call log permission is allowed).
        register(IntentFilter(android.telephony.TelephonyManager.ACTION_PHONE_STATE_CHANGED)) { i -> Calls.onPhoneState(context, i) }
        // New SMS (only the system may send this broadcast: BROADCAST_SMS).
        val smsReceiver = object : BroadcastReceiver() { override fun onReceive(c: Context, i: Intent) = Sms.onReceived(context, i) }
        ContextCompat.registerReceiver(context, smsReceiver, IntentFilter(android.provider.Telephony.Sms.Intents.SMS_RECEIVED_ACTION),
            "android.permission.BROADCAST_SMS", null, ContextCompat.RECEIVER_EXPORTED)
        receivers += smsReceiver
        // Clipboard: Android only reports changes while DropWave is on screen.
        clipboard().addPrimaryClipChangedListener { clip()?.let { emit("clip", it) } }
        val intent = activity.intent
        if (isShare(intent)) collectShare(intent, false)
    }

    override fun handleOnDestroy() {
        receivers.forEach { runCatching { context.unregisterReceiver(it) } }
        receivers.clear()
        scope.cancel()
        if (instance === this) instance = null
        super.handleOnDestroy()
    }

    private fun register(filter: IntentFilter, onReceive: (Intent) -> Unit) {
        val r = object : BroadcastReceiver() { override fun onReceive(c: Context, i: Intent) = onReceive(i) }
        ContextCompat.registerReceiver(context, r, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        receivers += r
    }

    // ---------- full screen (viewing / controlling a PC's screen) ----------

    /** on: landscape, no status/navigation bars, screen kept on. off: back to normal. */
    @PluginMethod
    fun setImmersive(call: PluginCall) {
        val on = call.getBoolean("on", false) == true
        activity.runOnUiThread {
            val a = activity
            a.requestedOrientation = if (on) ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE else ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            val c = WindowCompat.getInsetsController(a.window, a.window.decorView)
            if (on) {
                c.hide(WindowInsetsCompat.Type.systemBars())
                c.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                a.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } else {
                c.show(WindowInsetsCompat.Type.systemBars())
                a.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
        call.resolve()
    }

    // ---------- encryption ----------

    /** Trust this PC certificate fingerprint (hex SHA-256) from now on. */
    @PluginMethod
    fun pinCert(call: PluginCall) {
        Pins.add(context, call.getString("fp", ""))
        call.resolve()
    }

    // ---------- notifications ----------

    override fun handleOnResume() {
        super.handleOnResume()
        onScreen = true
        pendingAction?.let { emit("action", JSObject().put("action", it)) } // e.g. the PC asked for a scan
        Notifs.cancelAll(context) // the page shows everything now
        emit("access", JSObject()) // a permission may have changed while we were away
    }

    override fun handleOnPause() {
        super.handleOnPause()
        onScreen = false
    }

    @PluginMethod
    fun showNotification(call: PluginCall) {
        val id = call.getString("id", "dropwave")!!
        Log.i(TAG, "notification ${call.getString("kind")} $id" + if (onScreen) " (on screen: skipped)" else "")
        if (onScreen) { call.resolve(JSObject().put("shown", false)); return } // the page's own cards/toasts show it
        Notifs.show(context, id, call.getString("kind", "text")!!, call.getString("title", "DropWave")!!, call.getString("body", "")!!)
        call.resolve()
    }

    @PluginMethod
    fun cancelNotify(call: PluginCall) {
        call.getString("id")?.let { Notifs.cancel(context, it) } ?: Notifs.cancelAll(context)
        call.resolve()
    }

    /** on=true: stay connected in the background (and ask for the notification permission once). */
    @PluginMethod
    fun keepAlive(call: PluginCall) {
        val on = call.getBoolean("on", true) == true
        val i = Intent(context, KeepAliveService::class.java).putExtra("text", call.getString("text", "Connected"))
        try {
            if (on) {
                askNotificationPermission()
                context.startForegroundService(i)
            } else {
                context.stopService(i)
            }
            call.resolve()
        } catch (e: Exception) {
            // Android 12+ refuses to start a foreground service while the app is in the background.
            Log.w(TAG, "keepAlive($on) failed", e)
            call.reject(e.message)
        }
    }

    private fun askNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return
        val p = Manifest.permission.POST_NOTIFICATIONS
        if (ContextCompat.checkSelfPermission(context, p) == PackageManager.PERMISSION_GRANTED) return
        val sp = context.getSharedPreferences("dropwave", Context.MODE_PRIVATE)
        if (sp.getBoolean("askedNotif", false)) return // ask once; after that it's in Android settings
        sp.edit().putBoolean("askedNotif", true).apply()
        ActivityCompat.requestPermissions(activity, arrayOf(p), 7301)
    }

    // ---------- phone on PC ----------

    /** Battery, model, Android version, media volume and whether notification access is on. */
    @PluginMethod
    fun phoneStatus(call: PluginCall) {
        val b = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val maker = Build.MANUFACTURER.orEmpty()
        val model = Build.MODEL.orEmpty().let { if (maker.isNotEmpty() && !it.lowercase().startsWith(maker.lowercase())) "${maker.replaceFirstChar { c -> c.uppercase() }} $it" else it }
        val v = volumeState()
        call.resolve(JSObject()
            .put("battery", battery(b))
            .put("charging", charging(b))
            .put("model", model)
            .put("android", Build.VERSION.RELEASE)
            .put("volume", v.getInteger("volume"))
            .put("volumeMax", v.getInteger("volumeMax"))
            .put("muted", v.getBool("muted"))
            .put("notifAccess", PhoneListener.enabled(context))
            .put("photosAccess", PhotoLibrary.access(context))
            .put("callsAccess", Calls.access(context))
            .put("smsAccess", Sms.access(context))
            .put("filesAccess", PhoneFiles.access())
            .put("controlAccess", ControlService.enabled(context))
            .put("mirroring", MirrorService.running)
            .put("unrestricted", Access.unrestricted(context))
            .put("maker", Oem.brand()))
    }

    // ---------- permissions & privacy ----------

    @PluginMethod
    fun accessState(call: PluginCall) = call.resolve(Access.state(context))

    /** Ask Android for a group (or open the settings page for access only settings can grant). */
    @PluginMethod
    fun requestAccess(call: PluginCall) {
        when (val g = call.getString("group", "")!!) {
            "notifAccess" -> return openNotifAccess(call)
            "files" -> return openFilesAccess(call)
            "control" -> return openControlAccess(call)
            "usage" -> { runCatching { activity.startActivity(Apps.usageIntent()) }; return call.resolve() }
            "battery" -> {
                // Android's own "Let app always run in background?" dialog.
                val i = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
                if (runCatching { activity.startActivity(i) }.isFailure) openAppSettings(call) else call.resolve()
                return
            }
            else -> {
                val ps = Access.GROUPS[g] ?: return call.reject("Unknown access")
                ActivityCompat.requestPermissions(activity, ps, 7330)
            }
        }
        call.resolve()
    }

    /** Turn access off: give runtime permissions back (Android 13+, DropWave restarts), or open the settings page. */
    @PluginMethod
    fun revokeAccess(call: PluginCall) {
        val g = call.getString("group", "")!!
        when (g) {
            "notifAccess" -> return openNotifAccess(call)
            "files" -> return openFilesAccess(call)
            "usage" -> { runCatching { activity.startActivity(Apps.usageIntent()) }; return call.resolve() }
            "battery" -> {
                runCatching { activity.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }
                return call.resolve()
            }
            "control" -> {
                val s = ControlService.instance
                if (s != null) { s.off(); call.resolve(JSObject().put("done", true)) } else openControlAccess(call)
                return
            }
        }
        if (!Access.GROUPS.containsKey(g)) return call.reject("Unknown access")
        call.resolve(JSObject().put("restarting", true))
        activity.runOnUiThread {
            if (!Access.revoke(context, g)) openAppSettings(call) // before Android 13: the app's permission page
        }
    }

    @PluginMethod
    fun openAppSettings(call: PluginCall) {
        val i = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
        runCatching { activity.startActivity(i) }
        if (!call.isReleased) runCatching { call.resolve() }
    }

    @PluginMethod
    fun setAccessPref(call: PluginCall) {
        val key = call.getString("key", "")!!
        if (key !in setOf("controlBankingOff", "controlAutoOff")) return call.reject("Unknown setting")
        Access.prefs(context).edit().putBoolean(key, call.getBoolean("value", false) == true).apply()
        call.resolve(Access.state(context))
    }

    /** The phone maker's own "let it run in the background" page (Xiaomi autostart, Realme battery…). */
    @PluginMethod
    fun openBackgroundPage(call: PluginCall) = call.resolve(JSObject().put("opened", Oem.openBackgroundPage(context, activity)))

    /** PCs announcing themselves on this Wi-Fi (listens for up to ms). */
    @PluginMethod
    fun discoverPcs(call: PluginCall) {
        val ms = (call.getInt("ms", 2500) ?: 2500).toLong()
        scope.launch { call.resolve(Discovery.listen(context, ms)) }
    }

    // ---------- native link to the PC (keeps working while the page sleeps) ----------

    @PluginMethod
    fun linkStart(call: PluginCall) {
        val base = call.getString("base", "")!!
        if (!(base.startsWith("http://") || base.startsWith("https://"))) return call.reject("No PC address")
        Link.start(context, Link.Config(base, call.getString("key", "")!!, call.getString("id", "")!!, call.getString("name", "")!!))
        call.getString("pcName")?.takeIf { it.isNotBlank() }?.let { Access.prefs(context).edit().putString("pc_name", it).apply() }
        DropWaveWidget.refresh(context)
        call.resolve()
    }

    @PluginMethod
    fun linkStop(call: PluginCall) { Link.stop(); call.resolve() }

    /** Developer options, at Wireless debugging (for pairing with the PC without a cable). */
    @PluginMethod
    fun openWirelessDebugging(call: PluginCall) {
        val dev = android.provider.Settings.Global.getInt(context.contentResolver, android.provider.Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 0) == 1
        if (!dev) return call.reject("Developer options are off. Settings › About phone › tap Build number 7 times first.")
        val i = android.content.Intent(android.provider.Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS)
            .putExtra(":settings:fragment_args_key", "toggle_adb_wireless")
            .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
        try { context.startActivity(i); call.resolve() } catch (e: Exception) { call.reject(e.message ?: "Couldn’t open settings") }
    }

    /** The page takes a PC command / event; false when the native link already did. */
    @PluginMethod
    fun linkClaim(call: PluginCall) = call.resolve(JSObject().put("ok", Link.claim(call.getString("id", "")!!, true)))

    @PluginMethod
    fun setShare(call: PluginCall) { Link.setShare(context, call.getString("json", "{}")!!); call.resolve() }

    // ---------- contacts, apps, phone controls, camera for the PC ----------

    @PluginMethod
    fun contacts(call: PluginCall) {
        if (Access.group(context, "contacts") != "all") return call.reject("Allow contacts on the phone first (DropWave › Privacy)")
        scope.launch { try { call.resolve(Contacts.list(context)) } catch (e: Exception) { call.reject(e.message ?: "Couldn’t read contacts") } }
    }

    @PluginMethod
    fun contactPhoto(call: PluginCall) {
        val id = call.getLong("id") ?: call.getInt("id")?.toLong() ?: return call.reject("No contact")
        scope.launch { call.resolve(JSObject().put("data", Contacts.photo(context, id))) }
    }

    @PluginMethod
    fun requestContacts(call: PluginCall) {
        ActivityCompat.requestPermissions(activity, Access.GROUPS["contacts"]!!, 7331)
        call.resolve()
    }

    @PluginMethod
    fun apps(call: PluginCall) {
        scope.launch { try { call.resolve(Apps.list(context)) } catch (e: Exception) { call.reject(e.message ?: "Couldn’t list apps") } }
    }

    /** open | info | uninstall: on screen now, or a notification to tap. */
    @PluginMethod
    fun appAction(call: PluginCall) {
        val pkg = call.getString("pkg", "")!!
        val name = Apps.label(context, pkg)
        val r = when (call.getString("action", "")) {
            "open" -> Launch.openOrNotify(context, Apps.openIntent(context, pkg) ?: return call.reject("That app can’t be opened"), onScreen, "Open $name", "Your PC wants to open $name. Tap to open it.")
            "info" -> Launch.openOrNotify(context, Apps.infoIntent(pkg), onScreen, "$name: app info", "Tap to see $name in Android settings")
            "uninstall" -> Launch.openOrNotify(context, Apps.uninstallIntent(pkg), onScreen, "Uninstall $name?", "Your PC asked to uninstall $name. Tap to confirm on the phone.")
            "usage" -> Launch.openOrNotify(context, Apps.usageIntent(), onScreen, "Show recent apps on your PC", "Tap, then turn on Usage access for DropWave")
            else -> return call.reject("Unknown action")
        }
        call.resolve(JSObject().put("result", r))
    }

    /** Copy an app's APK to the PC (token from the PC). */
    @PluginMethod
    fun appApk(call: PluginCall) {
        val (f, name) = Apps.apk(context, call.getString("pkg", "")!!) ?: return call.reject("This app is split into parts, so it can’t be copied as one APK")
        val base = call.getString("base", "")!!
        if (!(base.startsWith("http://") || base.startsWith("https://"))) return call.reject("No PC address")
        call.resolve(JSObject().put("name", name).put("size", f.length()))
        scope.launch { Upload.file(context, f, name, "0", base, call.getString("key", "")!!, call.getString("token", "")!!, call.getString("from", "")!!) }
    }

    @PluginMethod
    fun controlsState(call: PluginCall) = call.resolve(PhoneControls.state(context))

    @PluginMethod
    fun controlsSet(call: PluginCall) {
        val what = call.getString("what", "")!!
        val v: Any? = call.data.opt("value")
        val value = if (v is org.json.JSONObject) JSObject.fromJSONObject(v) else v
        try { call.resolve(PhoneControls.set(context, what, value, onScreen)) } catch (e: Exception) { call.reject(e.message ?: "Couldn’t do that") }
    }

    /** Phone as webcam: start (asks on screen or by notification), stop, switch camera / torch. */
    @PluginMethod
    fun webcamStart(call: PluginCall) {
        val base = call.getString("base", "")!!
        if (!(base.startsWith("http://") || base.startsWith("https://"))) return call.reject("No PC address")
        val r = WebcamService.ask(context, WebcamService.Request(base, call.getString("key", "")!!, call.getString("token", "")!!, call.getString("from", "")!!, call.getBoolean("front", false) == true), onScreen)
        call.resolve(JSObject().put("result", r))
    }

    @PluginMethod
    fun webcamStop(call: PluginCall) { WebcamService.pending = null; WebcamService.stop(context); call.resolve() }

    /** Phone as the PC's microphone: start (asks on screen or by notification), stop. */
    @PluginMethod
    fun micStart(call: PluginCall) {
        val base = call.getString("base", "")!!
        if (!(base.startsWith("http://") || base.startsWith("https://"))) return call.reject("No PC address")
        val r = MicService.ask(context, MicService.Request(base, call.getString("key", "")!!, call.getString("token", "")!!, call.getString("from", "")!!), onScreen)
        call.resolve(JSObject().put("result", r))
    }

    @PluginMethod
    fun micStop(call: PluginCall) { MicService.pending = null; MicService.stop(context); call.resolve() }

    /** Bring DropWave up on a page action ("scan"): now if it's on screen, otherwise by a notification. */
    @PluginMethod
    fun openFor(call: PluginCall) {
        val r = openFor(context, call.getString("action", "")!!, call.getString("title", "DropWave")!!, call.getString("text", "Tap to open")!!)
        call.resolve(JSObject().put("result", r))
    }

    /** Google's document scanner; the pages arrive as a "docScanned" event. */
    @PluginMethod
    fun docScan(call: PluginCall) {
        try { activity.startActivity(Intent(context, DocScanActivity::class.java)); call.resolve() }
        catch (e: Exception) { call.reject(e.message ?: "unavailable") }
    }

    @PluginMethod
    fun takeAction(call: PluginCall) {
        val a = pendingAction
        pendingAction = null
        call.resolve(JSObject().put("action", a ?: ""))
    }

    @PluginMethod
    fun webcamSet(call: PluginCall) {
        val s = WebcamService.instance ?: return call.reject("The webcam is off")
        if (call.data.has("front")) s.switchCamera(call.getBoolean("front", false) == true)
        if (call.data.has("torch")) s.setTorch(call.getBoolean("torch", false) == true)
        call.resolve()
    }

    /** Take a photo / video for the PC with the phone's camera app. */
    @PluginMethod
    fun cameraOpen(call: PluginCall) {
        val base = call.getString("base", "")!!
        if (!(base.startsWith("http://") || base.startsWith("https://"))) return call.reject("No PC address")
        val video = call.getString("mode", "photo") == "video"
        CameraActivity.pending = CameraActivity.Request(base, call.getString("key", "")!!, call.getString("token", "")!!, call.getString("from", "")!!, video)
        val i = Intent(context, CameraActivity::class.java)
        val r = Launch.openOrNotify(context, i, onScreen, if (video) "Your PC wants a video" else "Your PC wants a photo", "Tap to open the camera. It goes straight to the PC.")
        call.resolve(JSObject().put("result", r))
    }

    // ---------- phone screen on PC ----------

    /** The PC asked to see this screen: Android's consent prompt now (app on screen) or via a notification. */
    @PluginMethod
    fun mirrorStart(call: PluginCall) {
        val base = call.getString("base", "")!!
        if (!(base.startsWith("http://") || base.startsWith("https://"))) return call.reject("No PC address")
        MirrorService.pending = MirrorService.Request(base, call.getString("key", "")!!, call.getString("token", "")!!, call.getString("from", "")!!)
        val open = Intent(context, MirrorConsentActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (onScreen) {
            activity.startActivity(open)
        } else {
            val pi = android.app.PendingIntent.getActivity(context, MirrorConsentActivity.MIRROR_ASK_ID, open, android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT)
            Notifs.post(context, MirrorConsentActivity.MIRROR_ASK_ID, androidx.core.app.NotificationCompat.Builder(context, Notifs.CH_TRANSFERS)
                .setSmallIcon(R.drawable.ic_stat_dropwave)
                .setContentTitle("Your PC wants to see this screen")
                .setContentText("Tap to start showing it on the PC")
                .setPriority(androidx.core.app.NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setContentIntent(pi))
        }
        call.resolve(JSObject().put("prompted", onScreen))
    }

    @PluginMethod
    fun mirrorStop(call: PluginCall) {
        MirrorService.pending = null
        MirrorService.stop(context)
        call.resolve()
    }

    /** Settings › Accessibility, where the user turns on "DropWave: control from PC". */
    @PluginMethod
    fun openControlAccess(call: PluginCall) {
        activity.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        call.resolve()
    }

    @PluginMethod
    fun mirrorInput(call: PluginCall) {
        val s = ControlService.instance ?: return call.reject("Turn on “DropWave: control from PC” in Accessibility settings")
        if (s.handle(call.data)) call.resolve() else call.reject("Couldn’t do that")
    }

    // ---------- messages (SMS) ----------

    @PluginMethod
    fun requestSms(call: PluginCall) {
        ActivityCompat.requestPermissions(activity, Sms.permissions(), 7305)
        call.resolve()
    }

    @PluginMethod
    fun smsThreads(call: PluginCall) {
        val limit = (call.getInt("limit", 60) ?: 60).coerceIn(1, 200)
        scope.launch {
            try { call.resolve(JSObject().put("list", Sms.threads(context, limit)).put("access", Sms.access(context))) } catch (e: Exception) { call.reject(e.message) }
        }
    }

    @PluginMethod
    fun smsThread(call: PluginCall) {
        val id = call.data.optLong("thread", -1L).takeIf { it >= 0 } ?: return call.reject("No conversation") // getLong() can't read a JS number that fits an int
        scope.launch {
            try { call.resolve(JSObject().put("thread", id).put("messages", Sms.thread(context, id, 150))) } catch (e: Exception) { call.reject(e.message) }
        }
    }

    @PluginMethod
    fun smsSend(call: PluginCall) {
        val err = Sms.send(context, call.getString("to", "")!!, call.getString("text", "")!!)
        if (err == null) call.resolve() else call.reject(err)
    }

    // ---------- phone files ----------

    /** Android settings page for "All files access" (the page re-reads phoneStatus on return). */
    @PluginMethod
    fun openFilesAccess(call: PluginCall) {
        val i = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:${context.packageName}"))
        try { activity.startActivity(i) } catch (e: Exception) { activity.startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)) }
        call.resolve()
    }

    @PluginMethod
    fun filesList(call: PluginCall) {
        if (PhoneFiles.access() != "all") return call.resolve(JSObject().put("access", "none"))
        val path = call.getString("path", "")!!
        val hidden = call.getBoolean("hidden", false) == true
        scope.launch {
            try { call.resolve(PhoneFiles.list(path, hidden).put("access", "all")) } catch (e: Exception) { call.reject(e.message) }
        }
    }

    @PluginMethod
    fun uploadFiles(call: PluginCall) {
        val paths = call.getArray("paths")?.toList<String>().orEmpty().take(500)
        val base = call.getString("base", "")!!
        if (paths.isEmpty() || !(base.startsWith("http://") || base.startsWith("https://"))) return call.reject("Nothing to send")
        call.resolve()
        scope.launch {
            PhoneFiles.upload(context, paths, base, call.getString("key", "")!!, call.getString("token", "")!!, call.getString("from", "")!!) { done, total ->
                emit("photoUpload", JSObject().put("done", done).put("total", total))
            }
        }
    }

    // ---------- calls ----------

    @PluginMethod
    fun requestCalls(call: PluginCall) {
        ActivityCompat.requestPermissions(activity, Calls.permissions(), 7304)
        call.resolve()
    }

    /** answer | decline | end */
    @PluginMethod
    fun callAction(call: PluginCall) {
        val err = Calls.control(context, call.getString("action", "")!!, call.getString("text", "")!!)
        if (err == null) call.resolve() else call.reject(err)
    }

    @PluginMethod
    fun dial(call: PluginCall) {
        val err = Calls.dial(context, call.getString("number", "")!!)
        if (err == null) call.resolve() else call.reject(err)
    }

    @PluginMethod
    fun callLog(call: PluginCall) {
        val limit = (call.getInt("limit", 50) ?: 50).coerceIn(1, 200)
        scope.launch { call.resolve(JSObject().put("list", Calls.log(context, limit)).put("access", Calls.access(context))) }
    }

    @PluginMethod
    fun callState(call: PluginCall) {
        call.resolve(JSObject().put("call", Calls.current() ?: JSONObject.NULL))
    }

    // ---------- photos (the PC's Photos page) ----------

    /** Ask for the photo permission (the page re-reads phoneStatus when DropWave is back on screen). */
    @PluginMethod
    fun requestPhotos(call: PluginCall) {
        ActivityCompat.requestPermissions(activity, PhotoLibrary.permissions(), 7303)
        call.resolve()
    }

    @PluginMethod
    fun photoPage(call: PluginCall) {
        val offset = call.getInt("offset", 0) ?: 0
        val limit = (call.getInt("limit", 60) ?: 60).coerceIn(1, 300)
        val kind = call.getString("kind", "all")!!
        scope.launch {
            if (PhotoLibrary.access(context) == "none") return@launch call.resolve(JSObject().put("access", "none").put("items", JSArray()))
            try {
                val after = call.data.optLong("after", 0L)
                val thumbs = call.getBoolean("thumbs", true) != false
                call.resolve(PhotoLibrary.page(context, offset, limit, kind, after, thumbs).put("access", PhotoLibrary.access(context)))
            } catch (e: Exception) {
                Log.w(TAG, "photo page", e)
                call.reject(e.message)
            }
        }
    }

    /** Upload the originals the PC asked for (token from the PC) to base/api/photo-upload. */
    @PluginMethod
    fun uploadPhotos(call: PluginCall) {
        val ids = call.getArray("ids")?.toList<String>().orEmpty().take(500)
        val base = call.getString("base", "")!!
        if (ids.isEmpty() || !(base.startsWith("http://") || base.startsWith("https://"))) return call.reject("Nothing to send")
        call.resolve()
        scope.launch {
            PhotoLibrary.upload(context, ids, base, call.getString("key", "")!!, call.getString("token", "")!!, call.getString("from", "")!!) { done, total ->
                emit("photoUpload", JSObject().put("done", done).put("total", total))
            }
        }
    }

    private fun audio() = context.getSystemService(AudioManager::class.java)

    /** Media volume: level 0..max and whether it's muted. */
    private fun volumeState(): JSObject {
        val am = audio()
        val s = AudioManager.STREAM_MUSIC
        return JSObject().put("volume", am.getStreamVolume(s)).put("volumeMax", am.getStreamMaxVolume(s)).put("muted", am.isStreamMute(s))
    }

    /** up | down | mute (toggle) | set (value 0..max). Changes the phone's media volume. */
    @PluginMethod
    fun volume(call: PluginCall) {
        val am = audio()
        val s = AudioManager.STREAM_MUSIC
        try {
            when (call.getString("action", "")) {
                "up" -> am.adjustStreamVolume(s, AudioManager.ADJUST_RAISE, 0)
                "down" -> am.adjustStreamVolume(s, AudioManager.ADJUST_LOWER, 0)
                "mute" -> am.adjustStreamVolume(s, AudioManager.ADJUST_TOGGLE_MUTE, 0)
                "set" -> {
                    val v = (call.getInt("value", 0) ?: 0).coerceIn(0, am.getStreamMaxVolume(s))
                    if (am.isStreamMute(s) && v > 0) am.adjustStreamVolume(s, AudioManager.ADJUST_UNMUTE, 0)
                    am.setStreamVolume(s, v, 0)
                }
                else -> { call.reject("Unknown volume action"); return }
            }
            call.resolve(volumeState())
        } catch (e: SecurityException) {
            call.reject("Android blocked the volume change (Do Not Disturb?)")
        }
    }

    /** System settings page where the user turns on notification access for DropWave. */
    @PluginMethod
    fun openNotifAccess(call: PluginCall) {
        var i = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
        if (Build.VERSION.SDK_INT >= 30) {
            val d = Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
                .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, ComponentName(context, PhoneListener::class.java).flattenToString())
            if (d.resolveActivity(context.packageManager) != null) i = d
        }
        try { activity.startActivity(i); call.resolve() } catch (e: Exception) { call.reject(e.message) }
    }

    @PluginMethod
    fun notifSnapshot(call: PluginCall) {
        call.resolve(JSObject().put("list", PhoneListener.instance?.snapshot() ?: JSArray()))
    }

    @PluginMethod
    fun mediaSnapshot(call: PluginCall) {
        call.resolve(JSObject().put("media", PhoneListener.instance?.media() ?: JSONObject.NULL))
    }

    @PluginMethod
    fun appIcon(call: PluginCall) {
        val pkg = call.getString("pkg", "")!!
        scope.launch { call.resolve(JSObject().put("data", PhoneListener.icon(context, pkg))) }
    }

    @PluginMethod
    fun notifAction(call: PluginCall) {
        val l = PhoneListener.instance ?: return call.reject("Notification access is off")
        val ok = l.act(call.getString("key", "")!!, call.getString("action", "")!!, call.getInt("i", 0) ?: 0, call.getString("text", "")!!)
        if (ok) call.resolve() else call.reject("That notification is gone")
    }

    @PluginMethod
    fun mediaControl(call: PluginCall) {
        val ok = PhoneListener.instance?.mediaControl(call.getString("action", "")!!, call.getDouble("pos") ?: 0.0) == true
        if (ok) call.resolve() else call.reject("Nothing playing")
    }

    @PluginMethod
    fun ring(call: PluginCall) {
        if (call.getBoolean("on", true) == true) Ringer.start(context) else Ringer.stop(context)
        call.resolve()
    }

    private fun clipboard() = context.getSystemService(ClipboardManager::class.java)

    /** Text on the clipboard; passwords from password managers are marked sensitive (never sent). */
    private fun clip(): JSObject? = try {
        val d = clipboard().primaryClip
        val t = d?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.text
        t?.let {
            val sensitive = d.description?.extras?.getBoolean("android.content.extra.IS_SENSITIVE", false) == true
            JSObject().put("text", it.toString()).put("sensitive", sensitive)
        }
    } catch (e: Exception) {
        null
    }

    /** Only works while DropWave is on screen (Android rule). */
    @PluginMethod
    fun readClipboard(call: PluginCall) = call.resolve(clip() ?: JSObject().put("text", ""))

    @PluginMethod
    fun setClipboard(call: PluginCall) {
        Clips.setFromPc(context, call.getString("text", "")!!)
        call.resolve()
    }

    // ---------- "Share → DropWave" ----------

    override fun handleOnNewIntent(intent: Intent) {
        super.handleOnNewIntent(intent)
        if (isShare(intent)) collectShare(intent, true)
    }

    private fun isShare(intent: Intent?) = intent?.action == Intent.ACTION_SEND || intent?.action == Intent.ACTION_SEND_MULTIPLE

    // Copy shared content:// files into the app cache so the web layer can read them.
    private fun collectShare(intent: Intent, notify: Boolean) {
        Log.i(TAG, "share intent: ${intent.action} type=${intent.type} notify=$notify")
        scope.launch {
            val files = JSArray()
            val errors = JSArray()
            val uris: List<Uri> = if (intent.action == Intent.ACTION_SEND) {
                listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
            } else {
                IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
            }
            val dir = File(context.cacheDir, "shared/${System.currentTimeMillis()}").apply { mkdirs() }
            val cr = context.contentResolver
            for (u in uris) {
                try {
                    val name = displayName(cr, u)
                    val out = File(dir, name)
                    (cr.openInputStream(u) ?: continue).use { input -> out.outputStream().use { input.copyTo(it, 1 shl 16) } }
                    files.put(JSObject()
                        .put("path", out.absolutePath)
                        .put("name", name)
                        .put("type", cr.getType(u) ?: "application/octet-stream")
                        .put("size", out.length()))
                    Log.i(TAG, "shared file copied: $name (${out.length()} bytes)")
                } catch (e: Exception) {
                    Log.w(TAG, "could not read shared item $u", e)
                    errors.put(e.message.toString())
                }
            }
            val text = intent.getStringExtra(Intent.EXTRA_TEXT)
            val data = JSObject().put("files", files).put("errors", errors).put("text", if (text != null && uris.isEmpty()) text else "")
            pendingShare = data
            Log.i(TAG, "share ready: ${files.length()} file(s), notify=$notify")
            if (notify) notifyListeners("shared", data, true)
        }
    }

    private fun displayName(cr: ContentResolver, u: Uri): String {
        val name = runCatching {
            cr.query(u, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
        }.getOrNull() ?: u.lastPathSegment
        return (name?.takeIf { it.isNotEmpty() } ?: "shared-file").replace(UNSAFE, "_")
    }

    @PluginMethod
    fun takeShared(call: PluginCall) {
        val d = pendingShare
        pendingShare = null
        call.resolve(d ?: JSObject().put("files", JSArray()).put("text", ""))
    }

    // ---------- files ----------

    @PluginMethod
    fun download(call: PluginCall) {
        val url = call.getString("url")
        val name = call.getString("name", "download")!!
        Log.i(TAG, "download $name")
        if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) return call.reject("Bad URL")
        val safe = name.replace(UNSAFE, "_")
        if (url.startsWith("https://")) {
            // Encrypted, pinned connection to the PC: our own downloader (DownloadManager can't pin).
            PinnedDownload.start(context, url, safe)
            return call.resolve(JSObject().put("id", -1))
        }
        try {
            val r = DownloadManager.Request(Uri.parse(url))
                .setTitle(safe)
                .setDescription("DropWave")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "DropWave/$safe")
            call.resolve(JSObject().put("id", context.getSystemService(DownloadManager::class.java).enqueue(r)))
        } catch (e: Exception) {
            call.reject(e.message)
        }
    }

    @PluginMethod
    fun minimize(call: PluginCall) {
        activity.runOnUiThread { activity.moveTaskToBack(true) }
        call.resolve()
    }

    @PluginMethod
    fun localIps(call: PluginCall) {
        val ips = JSArray()
        runCatching {
            NetworkInterface.getNetworkInterfaces().toList()
                .filter { it.isUp && !it.isLoopback && !it.isVirtual }
                .forEach { ni ->
                    ni.inetAddresses.toList()
                        .filter { it is Inet4Address && !it.isLoopbackAddress && !it.isLinkLocalAddress }
                        .forEach { ips.put(JSObject().put("address", it.hostAddress).put("iface", ni.name)) }
                }
        }
        call.resolve(JSObject().put("ips", ips))
    }

    companion object {
        private val UNSAFE = Regex("[\\\\/:*?\"<>|]")

        @Volatile private var instance: DropWavePlugin? = null

        // Whether DropWave is on screen. Tracked here because the page's visibilityState isn't reliable:
        // Capacitor keeps the WebView running in the background, so it can still say "visible".
        @Volatile private var onScreen = true
        fun isOnScreen() = onScreen

        @Volatile var pendingAction: String? = null
        fun openFor(ctx: Context, action: String, title: String, text: String): String {
            pendingAction = action
            if (onScreen && instance != null) { emit("action", JSObject().put("action", action)); return "opened" }
            val i = Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
            return Launch.openOrNotify(ctx, i, false, title, text)
        }

        /** Pass an event to the page (phone notifications, media, battery, ring, clipboard). */
        fun emit(event: String, data: JSObject) {
            instance?.notifyListeners(event, data, false)
            Link.onEvent(event, data) // the page may be asleep: the native link tells the PC then
        }

        /** To the page only. */
        fun emitOnly(event: String, data: JSObject) {
            instance?.notifyListeners(event, data, false)
        }

        /** A Download/Decline tap on a notification, passed to the page as "notifAction". */
        fun fireAction(id: String, action: String) {
            val p = instance ?: return
            Log.i(TAG, "notification action $action for $id")
            p.notifyListeners("notifAction", JSObject().put("id", id).put("action", action), true)
        }

        private fun battery(i: Intent?): Int {
            if (i == null) return -1
            val level = i.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
            val scale = i.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
            return if (level < 0 || scale <= 0) -1 else (level * 100f / scale).roundToInt()
        }

        private fun charging(i: Intent?): Boolean {
            val s = i?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: return false
            return s == BatteryManager.BATTERY_STATUS_CHARGING || s == BatteryManager.BATTERY_STATUS_FULL
        }
    }
}

package com.dropwave.app

import android.Manifest
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject

/**
 * What DropWave may access on this phone, and turning it off again:
 *  - Android runtime permissions (photos, calls, SMS, contacts, microphone, camera, notifications):
 *    on Android 13+ DropWave gives them back itself (Android applies it when the app restarts).
 *  - Notification access and All files access: only in Android settings (we open the right page).
 *  - Control from PC (Accessibility): the service switches itself off.
 * Plus the safety options for control: off when a banking/payment app opens, off after mirroring.
 */
object Access {
    val GROUPS: Map<String, Array<String>> = buildMap {
        put("photos", PhotoLibrary.permissions())
        put("calls", Calls.permissions())
        put("sms", arrayOf(Manifest.permission.READ_SMS, Manifest.permission.SEND_SMS, Manifest.permission.RECEIVE_SMS))
        put("contacts", arrayOf(Manifest.permission.READ_CONTACTS))
        put("mic", arrayOf(Manifest.permission.RECORD_AUDIO))
        put("camera", arrayOf(Manifest.permission.CAMERA))
        if (Build.VERSION.SDK_INT >= 33) put("notifPost", arrayOf(Manifest.permission.POST_NOTIFICATIONS))
    }

    private fun granted(ctx: Context, p: String) = ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED

    /** "all" | "partial" | "none" for a runtime group. */
    fun group(ctx: Context, name: String): String {
        val ps = GROUPS[name] ?: return "none"
        val n = ps.count { granted(ctx, it) }
        return if (n == ps.size) "all" else if (n == 0) "none" else "partial"
    }

    fun state(ctx: Context): JSObject = JSObject()
        .put("notifPost", if (Build.VERSION.SDK_INT < 33) "all" else group(ctx, "notifPost"))
        .put("notifAccess", PhoneListener.enabled(ctx))
        .put("photos", PhotoLibrary.access(ctx))
        .put("calls", Calls.access(ctx))
        .put("sms", group(ctx, "sms"))
        .put("contacts", group(ctx, "contacts"))
        .put("mic", group(ctx, "mic"))
        .put("camera", group(ctx, "camera"))
        .put("files", PhoneFiles.access())
        .put("control", ControlService.enabled(ctx))
        .put("controlRunning", ControlService.instance != null)
        .put("battery", if (unrestricted(ctx)) "all" else "none")
        .put("usage", if (Apps.usageAllowed(ctx)) "all" else "none")
        .put("canRevoke", Build.VERSION.SDK_INT >= 33)
        .put("controlBankingOff", prefs(ctx).getBoolean("controlBankingOff", true))
        .put("controlAutoOff", prefs(ctx).getBoolean("controlAutoOff", false))

    /** Allowed to run without battery limits (Doze would otherwise cut the Wi-Fi link a few minutes after the screen goes off). */
    fun unrestricted(ctx: Context) = ctx.getSystemService(android.os.PowerManager::class.java).isIgnoringBatteryOptimizations(ctx.packageName)

    fun prefs(ctx: Context) = ctx.getSharedPreferences("dropwave", Context.MODE_PRIVATE)

    /**
     * Give a group back to Android (13+). Android removes it when the process ends, so DropWave
     * restarts itself a moment later. Returns false when this Android version can't do it.
     */
    fun revoke(ctx: Context, name: String): Boolean {
        if (Build.VERSION.SDK_INT < 33) return false
        val ps = GROUPS[name]?.filter { granted(ctx, it) }.orEmpty()
        if (ps.isEmpty()) return true
        ctx.revokeSelfPermissionsOnKill(ps)
        restart(ctx)
        return true
    }

    /** Relaunch DropWave in a moment and end this process (so revoked permissions take effect). */
    fun restart(ctx: Context) {
        val app = ctx.applicationContext
        val i = Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        val pi = PendingIntent.getActivity(app, 7320, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_CANCEL_CURRENT)
        runCatching { app.getSystemService(AlarmManager::class.java).set(AlarmManager.RTC, System.currentTimeMillis() + 800, pi) }
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({ android.os.Process.killProcess(android.os.Process.myPid()) }, 300)
    }

    // ---------- payment apps: control from PC switches itself off ----------

    fun isPaymentApp(pkg: String) = Payment.isPaymentApp(pkg)

    /** A banking / payment app came to the front: its screen never goes to the PC. */
    fun paymentAppOpened(ctx: Context, pkg: String) {
        if (!MirrorService.running) return
        val pm = ctx.packageManager
        val label = runCatching { pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString() }.getOrDefault(pkg)
        MirrorService.stopReason = "Screen sharing stopped: $label opened. Banking and UPI apps are never shown on the PC."
        MirrorService.stop(ctx)
        Notifs.post(ctx, 7322, androidx.core.app.NotificationCompat.Builder(ctx, Notifs.CH_STATUS)
            .setSmallIcon(R.drawable.ic_stat_dropwave)
            .setContentTitle("Screen sharing stopped")
            .setContentText("$label opened, so your PC no longer sees this screen.")
            .setAutoCancel(true)
            .setContentIntent(Notifs.openApp(ctx)))
    }

    /** The app in front right now, if Usage access is allowed (DropWave › Apps › Most used); else null. */
    fun foregroundApp(ctx: Context): String? = runCatching {
        val usm = ctx.getSystemService(android.app.usage.UsageStatsManager::class.java)
        val now = System.currentTimeMillis()
        val ev = usm.queryEvents(now - 10_000, now)
        val e = android.app.usage.UsageEvents.Event()
        var last: String? = null
        while (ev.hasNextEvent()) { ev.getNextEvent(e); if (e.eventType == android.app.usage.UsageEvents.Event.ACTIVITY_RESUMED) last = e.packageName }
        last
    }.getOrNull()
}

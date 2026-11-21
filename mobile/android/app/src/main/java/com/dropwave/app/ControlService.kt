package com.dropwave.app

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Context
import android.graphics.Path
import android.os.Bundle
import android.provider.Settings
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * Lets the PC use this phone while its screen is shown there: taps, long presses, swipes, Back /
 * Home / Recents, and typing into the focused text field. Android only runs it after the user
 * turns it on under Settings › Accessibility › DropWave. It reads nothing from the screen except
 * the focused text field, and only when the PC types into it.
 */
class ControlService : AccessibilityService() {

    override fun onServiceConnected() { instance = this }
    override fun onUnbind(intent: android.content.Intent?): Boolean { if (instance === this) instance = null; return super.onUnbind(intent) }
    // A banking / payment app came to the front: switch control from the PC off (those apps often
    // refuse to run while another app could tap for you). The user turns it on again in DropWave.
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event?.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        val pkg = event.packageName?.toString() ?: return
        if (pkg == packageName || !Access.isPaymentApp(pkg)) return
        Access.paymentAppOpened(this, pkg)
        if (!Access.prefs(this).getBoolean("controlBankingOff", true)) return
        val label = runCatching { packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString() }.getOrDefault(pkg)
        Notifs.post(this, 7321, androidx.core.app.NotificationCompat.Builder(this, Notifs.CH_STATUS)
            .setSmallIcon(R.drawable.ic_stat_dropwave)
            .setContentTitle("Control from PC is off")
            .setContentText("$label opened, so DropWave switched it off. Turn it on again in DropWave › Privacy.")
            .setStyle(androidx.core.app.NotificationCompat.BigTextStyle().bigText("$label opened, so DropWave switched off control from the PC. Turn it on again in DropWave › Privacy."))
            .setAutoCancel(true)
            .setContentIntent(Notifs.openApp(this)))
        off()
    }

    // While the PC taps and types here, a notice says so, with a way to stop it at once.
    private val notice = android.os.Handler(android.os.Looper.getMainLooper())
    private val clearNotice = Runnable { androidx.core.app.NotificationManagerCompat.from(this).cancel(NOTICE_ID) }
    private var noticeShown = 0L
    private fun controlling() {
        val now = System.currentTimeMillis()
        if (now - noticeShown > 15_000) {
            noticeShown = now
            val off = android.app.PendingIntent.getBroadcast(this, NOTICE_ID, android.content.Intent(this, ControlOffReceiver::class.java), android.app.PendingIntent.FLAG_IMMUTABLE)
            Notifs.post(this, NOTICE_ID, androidx.core.app.NotificationCompat.Builder(this, Notifs.CH_STATUS)
                .setSmallIcon(R.drawable.ic_stat_dropwave)
                .setContentTitle("Your PC is controlling this phone")
                .setContentText("Not you? Tap Stop.")
                .setOngoing(true).setSilent(true)
                .addAction(0, "Stop", off)
                .setContentIntent(Notifs.openApp(this)))
        }
        notice.removeCallbacks(clearNotice)
        notice.postDelayed(clearNotice, 20_000)
    }

    /** Switch this service off (Android shows it as off in Accessibility settings too). */
    fun off() {
        notice.removeCallbacks(clearNotice); androidx.core.app.NotificationManagerCompat.from(this).cancel(NOTICE_ID)
        instance = null
        DropWavePlugin.emit("access", com.getcapacitor.JSObject())
        disableSelf()
    }
    override fun onInterrupt() {}

    private fun px(x: Double, y: Double): Pair<Float, Float> {
        val b = getSystemService(WindowManager::class.java).maximumWindowMetrics.bounds
        return Pair((x.coerceIn(0.0, 1.0) * (b.width() - 1)).toFloat(), (y.coerceIn(0.0, 1.0) * (b.height() - 1)).toFloat())
    }

    private fun gesture(path: Path, ms: Long) {
        dispatchGesture(GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, ms.coerceIn(1, 3000))).build(), null, null)
    }

    /** One input event from the PC: { t: tap | long | swipe | back | home | recents | notifications | text | backspace | enter, x, y, x2, y2, ms, s } */
    fun handle(e: com.getcapacitor.JSObject): Boolean {
        controlling()
        when (e.getString("t")) {
            "tap", "long" -> {
                val (x, y) = px(e.optDouble("x"), e.optDouble("y"))
                gesture(Path().apply { moveTo(x, y) }, if (e.getString("t") == "long") 650 else 40)
            }
            "swipe" -> {
                val (x1, y1) = px(e.optDouble("x"), e.optDouble("y"))
                val (x2, y2) = px(e.optDouble("x2"), e.optDouble("y2"))
                gesture(Path().apply { moveTo(x1, y1); lineTo(x2, y2) }, e.optLong("ms", 250))
            }
            "back" -> performGlobalAction(GLOBAL_ACTION_BACK)
            "home" -> performGlobalAction(GLOBAL_ACTION_HOME)
            "recents" -> performGlobalAction(GLOBAL_ACTION_RECENTS)
            "notifications" -> performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS)
            "lock" -> performGlobalAction(GLOBAL_ACTION_LOCK_SCREEN)
            "text", "backspace" -> {
                val n = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return false
                if (!n.isEditable) return false
                val cur = n.text?.toString().takeUnless { n.isShowingHintText }.orEmpty()
                val next = if (e.getString("t") == "text") cur + e.getString("s", "") else cur.dropLast(1)
                n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply {
                    putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, next)
                })
            }
            "enter" -> {
                val n = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return false
                n.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
            }
            else -> return false
        }
        return true
    }

    companion object {
        @Volatile var instance: ControlService? = null
        private const val NOTICE_ID = 7323

        fun enabled(ctx: Context): Boolean {
            val list = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
            return list.split(':').any { it.startsWith(ctx.packageName + "/") }
        }
    }
}

/** "Stop" on the "Your PC is controlling this phone" notice. */
class ControlOffReceiver : android.content.BroadcastReceiver() {
    override fun onReceive(context: android.content.Context, intent: android.content.Intent) {
        ControlService.instance?.off()
        androidx.core.app.NotificationManagerCompat.from(context).cancel(7323)
    }
}

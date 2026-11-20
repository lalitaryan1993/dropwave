package com.dropwave.app

import android.accessibilityservice.AccessibilityService
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.service.notification.NotificationListenerService
import com.getcapacitor.JSObject

/**
 * Quick controls for the PC: torch, Do Not Disturb, ring / vibrate, volumes, brightness, lock,
 * screenshot. Each one only does what Android allows this app to do:
 *  - Do Not Disturb works through notification access (or "Do Not Disturb access").
 *  - Brightness needs "Modify system settings" (the PC can open that page on the phone).
 *  - Lock and screenshot need "Control from PC".
 */
object PhoneControls {
    @Volatile private var torch = false
    private var torchId: String? = null
    private var watching = false

    private fun cams(ctx: Context) = ctx.getSystemService(CameraManager::class.java)

    /** Track the torch (it can also be switched from quick settings). */
    fun watch(ctx: Context, changed: () -> Unit) {
        if (watching) return
        watching = true
        val cm = cams(ctx)
        torchId = runCatching {
            cm.cameraIdList.firstOrNull { cm.getCameraCharacteristics(it).get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true }
        }.getOrNull()
        runCatching {
            cm.registerTorchCallback(object : CameraManager.TorchCallback() {
                override fun onTorchModeChanged(cameraId: String, enabled: Boolean) {
                    if (cameraId == torchId && torch != enabled) { torch = enabled; changed() }
                }
            }, Handler(Looper.getMainLooper()))
        }
    }

    private val STREAMS = mapOf(
        "media" to AudioManager.STREAM_MUSIC, "ring" to AudioManager.STREAM_RING,
        "notification" to AudioManager.STREAM_NOTIFICATION, "alarm" to AudioManager.STREAM_ALARM,
    )

    fun state(ctx: Context): JSObject {
        val am = ctx.getSystemService(AudioManager::class.java)
        val nm = ctx.getSystemService(NotificationManager::class.java)
        val vols = JSObject()
        STREAMS.forEach { (k, s) -> vols.put(k, JSObject().put("v", am.getStreamVolume(s)).put("max", am.getStreamMaxVolume(s))) }
        val canWrite = Settings.System.canWrite(ctx)
        val bright = runCatching { Settings.System.getInt(ctx.contentResolver, Settings.System.SCREEN_BRIGHTNESS) }.getOrDefault(-1)
        val auto = runCatching { Settings.System.getInt(ctx.contentResolver, Settings.System.SCREEN_BRIGHTNESS_MODE) == Settings.System.SCREEN_BRIGHTNESS_MODE_AUTOMATIC }.getOrDefault(false)
        return JSObject()
            .put("torch", torch).put("torchAvailable", torchId != null)
            .put("dnd", nm.currentInterruptionFilter > NotificationManager.INTERRUPTION_FILTER_ALL)
            .put("dndAvailable", PhoneListener.instance != null || nm.isNotificationPolicyAccessGranted)
            .put("ringer", when (am.ringerMode) { AudioManager.RINGER_MODE_SILENT -> "silent"; AudioManager.RINGER_MODE_VIBRATE -> "vibrate"; else -> "normal" })
            .put("volumes", vols)
            .put("brightness", bright).put("brightnessMax", 255).put("autoBrightness", auto).put("canWrite", canWrite)
            .put("control", ControlService.instance != null)
    }

    /** Throws with a message the PC can show. */
    fun set(ctx: Context, what: String, value: Any?, onScreen: Boolean): JSObject {
        val am = ctx.getSystemService(AudioManager::class.java)
        val nm = ctx.getSystemService(NotificationManager::class.java)
        val on = value == true || value == "true"
        when (what) {
            "torch" -> {
                val id = torchId ?: throw Exception("This phone has no flashlight")
                cams(ctx).setTorchMode(id, on)
                torch = on
            }
            "dnd" -> {
                val filter = if (on) NotificationManager.INTERRUPTION_FILTER_PRIORITY else NotificationManager.INTERRUPTION_FILTER_ALL
                val l = PhoneListener.instance
                when {
                    nm.isNotificationPolicyAccessGranted -> nm.setInterruptionFilter(filter)
                    l != null -> l.requestInterruptionFilter(
                        if (on) NotificationListenerService.INTERRUPTION_FILTER_PRIORITY else NotificationListenerService.INTERRUPTION_FILTER_ALL)
                    else -> throw Exception("Turn on notification access for DropWave on the phone first")
                }
            }
            "ringer" -> {
                val mode = when (value) { "vibrate" -> AudioManager.RINGER_MODE_VIBRATE; "silent" -> AudioManager.RINGER_MODE_SILENT; else -> AudioManager.RINGER_MODE_NORMAL }
                try { am.ringerMode = mode } catch (_: SecurityException) { throw Exception("Android blocked that while Do Not Disturb is on") }
            }
            "volume" -> {
                val o = value as? JSObject ?: throw Exception("Bad volume")
                val s = STREAMS[o.getString("stream")] ?: throw Exception("Unknown volume")
                val v = o.getInt("v").coerceIn(0, am.getStreamMaxVolume(s))
                try { am.setStreamVolume(s, v, 0) } catch (_: SecurityException) { throw Exception("Android blocked that while Do Not Disturb is on") }
            }
            "brightness" -> {
                if (!Settings.System.canWrite(ctx)) throw Exception("Allow “Modify system settings” for DropWave on the phone first")
                val cr = ctx.contentResolver
                Settings.System.putInt(cr, Settings.System.SCREEN_BRIGHTNESS_MODE, Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL)
                Settings.System.putInt(cr, Settings.System.SCREEN_BRIGHTNESS, ((value as? Number)?.toInt() ?: 128).coerceIn(1, 255))
            }
            "autoBrightness" -> {
                if (!Settings.System.canWrite(ctx)) throw Exception("Allow “Modify system settings” for DropWave on the phone first")
                Settings.System.putInt(ctx.contentResolver, Settings.System.SCREEN_BRIGHTNESS_MODE,
                    if (on) Settings.System.SCREEN_BRIGHTNESS_MODE_AUTOMATIC else Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL)
            }
            "allowSettings" -> {
                val i = Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS, Uri.parse("package:${ctx.packageName}"))
                val r = Launch.openOrNotify(ctx, i, onScreen, "Allow brightness from your PC", "Tap, then turn on “Allow modifying system settings”")
                return state(ctx).put("launch", r)
            }
            "lock", "screenshot" -> {
                val s = ControlService.instance ?: throw Exception("Turn on “Control from PC” on the phone first (DropWave › Privacy)")
                s.performGlobalAction(if (what == "lock") AccessibilityService.GLOBAL_ACTION_LOCK_SCREEN else AccessibilityService.GLOBAL_ACTION_TAKE_SCREENSHOT)
            }
            else -> throw Exception("Unknown control")
        }
        return state(ctx)
    }
}

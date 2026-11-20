package com.dropwave.app

import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Bundle

/**
 * Invisible screen that shows Android's own "Start recording or casting?" prompt for a mirroring
 * request from the PC, then hands the answer to MirrorService. Opened from the app or by tapping
 * the "Your PC wants to see this screen" notification.
 */
class MirrorConsentActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (MirrorService.pending == null) { finish(); return }
        // Sound comes along when the microphone permission is allowed (Android's rule for audio capture).
        if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.RECORD_AUDIO), 2)
        } else askScreen()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        askScreen() // with or without sound
    }

    private fun askScreen() {
        val mpm = getSystemService(MediaProjectionManager::class.java)
        @Suppress("DEPRECATION")
        startActivityForResult(mpm.createScreenCaptureIntent(), 1)
    }

    @Deprecated("Activity result API is fine for this one-shot screen")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (resultCode == RESULT_OK && data != null) {
            startForegroundService(Intent(this, MirrorService::class.java).putExtra("code", resultCode).putExtra("data", data))
        } else {
            MirrorService.pending = null
            DropWavePlugin.emit("mirror", com.getcapacitor.JSObject().put("on", false).put("declined", true))
        }
        androidx.core.app.NotificationManagerCompat.from(this).cancel(MIRROR_ASK_ID)
        finish()
    }

    companion object { const val MIRROR_ASK_ID = 7311 }
}

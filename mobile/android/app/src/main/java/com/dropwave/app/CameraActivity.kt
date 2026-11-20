package com.dropwave.app

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.provider.MediaStore
import android.widget.Toast
import androidx.core.content.FileProvider
import com.getcapacitor.JSObject
import java.io.File
import kotlin.concurrent.thread

/**
 * Camera for the PC (continuity camera): opens the phone's own camera app; the photo or video
 * goes straight to the PC that asked, then is deleted from the phone. Opened from DropWave or by
 * tapping the "Your PC wants a photo" notification.
 */
class CameraActivity : Activity() {
    data class Request(val base: String, val key: String, val token: String, val from: String, val video: Boolean)

    private var file: File? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (pending == null) { finish(); return }
        // DropWave lists the camera permission, so Android wants it granted even for the camera app.
        if (checkSelfPermission(android.Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.CAMERA), 3)
        } else open()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) open() else done(cancelled = true, error = "Camera permission was not allowed")
    }

    private fun open() {
        val r = pending ?: return finish()
        val dir = File(cacheDir, "camera").apply { mkdirs() }
        val f = File(dir, "DropWave_${System.currentTimeMillis()}.${if (r.video) "mp4" else "jpg"}")
        file = f
        val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", f)
        val i = Intent(if (r.video) MediaStore.ACTION_VIDEO_CAPTURE else MediaStore.ACTION_IMAGE_CAPTURE)
            .putExtra(MediaStore.EXTRA_OUTPUT, uri)
            .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        try {
            @Suppress("DEPRECATION")
            startActivityForResult(i, 4)
        } catch (_: Exception) {
            done(cancelled = true, error = "No camera app on this phone")
        }
    }

    @Deprecated("Activity result API is fine for this one-shot screen")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        val r = pending
        val f = file
        if (r == null || f == null || resultCode != RESULT_OK || !f.exists() || f.length() == 0L) { done(cancelled = true); return }
        pending = null
        val app = applicationContext
        Toast.makeText(app, "Sending to your PC…", Toast.LENGTH_SHORT).show()
        thread {
            val ok = Upload.file(app, f, f.name, "0", r.base, r.key, r.token, r.from)
            f.delete()
            DropWavePlugin.emit("camera", JSObject().put("sent", ok))
        }
        finish()
    }

    private fun done(cancelled: Boolean, error: String? = null) {
        pending = null
        file?.delete()
        DropWavePlugin.emit("camera", JSObject().put("cancelled", cancelled).put("error", error))
        finish()
    }

    companion object {
        const val ASK_ID = 7341
        @Volatile var pending: Request? = null
    }
}

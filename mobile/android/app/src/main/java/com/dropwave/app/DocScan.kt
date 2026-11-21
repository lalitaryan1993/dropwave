package com.dropwave.app

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.util.Log
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult
import java.io.File

/**
 * "Scan to PC" with Google's document scanner (ML Kit, on the phone, nothing uploaded to Google):
 * live edge detection, automatic capture, crop, straighten, shadow and stain clean-up, several pages.
 * The pages are copied to the app cache and handed to the page ("docScanned"), which sends them to the PC.
 * Phones without Google Play services get "unavailable" and the page uses its own camera scanner.
 */
class DocScanActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState != null) return // coming back from the scanner after a config change
        val options = GmsDocumentScannerOptions.Builder()
            .setGalleryImportAllowed(true)
            .setPageLimit(40)
            .setResultFormats(GmsDocumentScannerOptions.RESULT_FORMAT_JPEG)
            .setScannerMode(GmsDocumentScannerOptions.SCANNER_MODE_FULL)
            .build()
        GmsDocumentScanning.getClient(options).getStartScanIntent(this)
            .addOnSuccessListener { sender ->
                try { startIntentSenderForResult(sender, REQ, null, 0, 0, 0) }
                catch (e: Exception) { done(JSObject().put("error", "unavailable").put("message", e.message)) }
            }
            .addOnFailureListener { e ->
                Log.w(TAG, "document scanner unavailable: ${e.message}")
                done(JSObject().put("error", "unavailable").put("message", e.message))
            }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ) return
        val result = if (resultCode == RESULT_OK) GmsDocumentScanningResult.fromActivityResultIntent(data) else null
        val pages = result?.pages.orEmpty()
        if (pages.isEmpty()) return done(JSObject().put("cancelled", true))
        val dir = File(cacheDir, "scans/${System.currentTimeMillis()}").apply { mkdirs() }
        val stamp = java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.US).format(java.util.Date())
        val files = JSArray()
        pages.forEachIndexed { k, p ->
            runCatching {
                // "docscan-": the PC knows these are already cropped and cleaned up.
                val out = File(dir, "docscan-$stamp-${(k + 1).toString().padStart(2, '0')}.jpg")
                contentResolver.openInputStream(p.imageUri)?.use { i -> out.outputStream().use { i.copyTo(it, 1 shl 16) } }
                files.put(JSObject().put("path", out.absolutePath).put("name", out.name).put("type", "image/jpeg").put("size", out.length()))
            }.onFailure { Log.w(TAG, "scan page $k: ${it.message}") }
        }
        done(JSObject().put("files", files))
    }

    private fun done(d: JSObject) {
        DropWavePlugin.emit("docScanned", d)
        finish()
    }

    companion object {
        private const val TAG = "DropWave"
        private const val REQ = 41
    }
}

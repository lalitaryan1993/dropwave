package com.dropwave.app

import android.app.PendingIntent
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import android.webkit.MimeTypeMap
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.net.URL
import javax.net.ssl.HttpsURLConnection

/**
 * Downloads a file from a paired PC over HTTPS (pinned certificate) into Download/DropWave.
 * Android's DownloadManager can't be used here: it only trusts certificate authorities.
 * Shows its own progress / done notification; tapping "done" opens the file.
 */
object PinnedDownload {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    fun start(ctx: Context, url: String, name: String) {
        val c = ctx.applicationContext
        scope.launch { run(c, url, name) }
    }

    private fun run(c: Context, url: String, name: String) {
        val nid = Notifs.num("dl:$url")
        val b = NotificationCompat.Builder(c, Notifs.CH_DOWNLOADS)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(name)
            .setContentText("Downloading…")
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .setProgress(100, 0, true)
        Notifs.post(c, nid, b)

        val cr = c.contentResolver
        var item: Uri? = null
        var conn: HttpsURLConnection? = null
        try {
            conn = (URL(url).openConnection() as HttpsURLConnection).apply {
                sslSocketFactory = Pins.socketFactory(c)
                setHostnameVerifier { _, _ -> true } // identity = pinned certificate, not a hostname
                connectTimeout = 15000
                readTimeout = 60000
            }
            if (conn.responseCode != 200) throw Exception("PC answered ${conn.responseCode}")
            val total = conn.contentLengthLong
            val mime = mimeFor(name, conn.contentType)

            val v = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, mime)
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/DropWave")
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            item = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v) ?: throw Exception("Couldn't create the file in Downloads")

            conn.inputStream.use { input ->
                (cr.openOutputStream(item) ?: throw Exception("Couldn't write to Downloads")).use { out ->
                    val buf = ByteArray(1 shl 16)
                    var done = 0L
                    var lastUi = 0L
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        out.write(buf, 0, n)
                        done += n
                        val now = System.currentTimeMillis()
                        if (now - lastUi > 500 && total > 0) {
                            lastUi = now
                            b.setProgress(100, (done * 100 / total).toInt(), false)
                            Notifs.post(c, nid, b)
                        }
                    }
                }
            }
            cr.update(item, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)

            val view = Intent(Intent.ACTION_VIEW).setDataAndType(item, mime)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            val open = PendingIntent.getActivity(c, nid, view, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            Notifs.post(c, nid, NotificationCompat.Builder(c, Notifs.CH_DOWNLOADS)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle(name)
                .setContentText("Saved to Download/DropWave")
                .setContentIntent(open)
                .setAutoCancel(true))
            Log.i(TAG, "downloaded $name")
        } catch (e: Exception) {
            Log.w(TAG, "download failed: $name", e)
            item?.let { runCatching { cr.delete(it, null, null) } }
            Notifs.post(c, nid, NotificationCompat.Builder(c, Notifs.CH_DOWNLOADS)
                .setSmallIcon(android.R.drawable.stat_notify_error)
                .setContentTitle(name)
                .setContentText("Download failed: ${e.message}")
                .setAutoCancel(true))
        } finally {
            conn?.disconnect()
        }
    }

    private fun mimeFor(name: String, header: String?): String {
        if (!header.isNullOrEmpty() && !header.startsWith("application/octet-stream")) return header.substringBefore(';').trim()
        val ext = name.substringAfterLast('.', "").lowercase()
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
    }
}

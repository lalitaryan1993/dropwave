package com.dropwave.app

import android.content.Context
import android.util.Log
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import javax.net.ssl.HttpsURLConnection

/** Sends one file to the PC's /api/photo-upload with a one-time token the PC handed out. */
object Upload {
    private const val TAG = "DropWave"

    fun file(ctx: Context, f: File, name: String, id: String, base: String, key: String, token: String, from: String): Boolean = try {
        val enc = { s: String -> URLEncoder.encode(s, "UTF-8") }
        val conn = URL("$base/api/photo-upload?token=${enc(token)}&from=${enc(from)}&id=${enc(id)}&name=${enc(name)}&mtime=${f.lastModified()}").openConnection() as HttpURLConnection
        if (conn is HttpsURLConnection) {
            conn.sslSocketFactory = Pins.socketFactory(ctx)
            conn.setHostnameVerifier { _, _ -> true } // identity = pinned certificate
        }
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.connectTimeout = 15000
        conn.readTimeout = 120000
        conn.setRequestProperty("X-DropWave-Key", key)
        conn.setRequestProperty("Content-Type", "application/octet-stream")
        conn.setFixedLengthStreamingMode(f.length())
        f.inputStream().use { input -> conn.outputStream.use { input.copyTo(it, 1 shl 16) } }
        val ok = conn.responseCode == 200
        if (!ok) Log.w(TAG, "upload $name: PC answered ${conn.responseCode}")
        conn.disconnect()
        ok
    } catch (e: Exception) {
        Log.w(TAG, "upload $name failed", e)
        false
    }
}

package com.dropwave.app

import android.content.Context
import android.os.Environment
import android.os.StatFs
import android.util.Log
import android.webkit.MimeTypeMap
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import javax.net.ssl.HttpsURLConnection

/**
 * The phone's storage for the PC's Files page: list folders and upload the files the PC asks for.
 * Needs "All files access", which the user turns on in Android settings for DropWave.
 * Paths are always relative to the phone's internal storage; nothing outside it is reachable.
 */
object PhoneFiles {
    private val root: File get() = Environment.getExternalStorageDirectory()

    fun access(): String = if (Environment.isExternalStorageManager()) "all" else "none"

    /** "a/b" -> the file under internal storage, or null if it would leave it. */
    private fun resolve(rel: String): File? {
        val f = File(root, rel.trim('/')).canonicalFile
        val r = root.canonicalFile
        return if (f == r || f.path.startsWith(r.path + File.separator)) f else null
    }

    fun list(rel: String, hidden: Boolean): JSObject {
        val dir = resolve(rel) ?: throw Exception("Not allowed")
        if (!dir.isDirectory) throw Exception("Folder not found")
        val items = JSArray()
        (dir.listFiles() ?: emptyArray())
            .filter { hidden || !it.name.startsWith(".") }
            .sortedWith(compareBy<File>({ !it.isDirectory }, { it.name.lowercase() }))
            .take(2000)
            .forEach { f ->
                val o = JSObject().put("name", f.name).put("dir", f.isDirectory).put("mtime", f.lastModified())
                if (f.isDirectory) o.put("count", f.list()?.count { hidden || !it.startsWith(".") } ?: 0)
                else o.put("size", f.length()).put("mime", MimeTypeMap.getSingleton().getMimeTypeFromExtension(f.extension.lowercase()) ?: "")
                items.put(o)
            }
        val st = StatFs(root.path)
        val rp = dir.canonicalPath.removePrefix(root.canonicalPath).trim('/')
        return JSObject().put("path", rp).put("items", items).put("total", st.totalBytes).put("free", st.availableBytes)
    }

    /** Upload files (relative paths) to the PC, which asked for them with this token. */
    fun upload(ctx: Context, rels: List<String>, base: String, key: String, token: String, from: String, progress: (Int, Int) -> Unit) {
        rels.forEachIndexed { i, rel ->
            val f = resolve(rel)
            try {
                if (f == null || !f.isFile) throw Exception("not a file: $rel")
                val enc = { s: String -> URLEncoder.encode(s, "UTF-8") }
                val conn = URL("$base/api/photo-upload?token=${enc(token)}&from=${enc(from)}&id=$i&name=${enc(f.name)}&mtime=${f.lastModified()}").openConnection() as HttpURLConnection
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
                if (conn.responseCode != 200) Log.w(TAG, "file upload $rel: PC answered ${conn.responseCode}")
                conn.disconnect()
            } catch (e: Exception) {
                Log.w(TAG, "file upload $rel failed", e)
            }
            progress(i + 1, rels.size)
        }
    }
}

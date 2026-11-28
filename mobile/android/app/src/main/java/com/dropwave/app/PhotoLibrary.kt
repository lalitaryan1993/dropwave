package com.dropwave.app

import android.Manifest
import android.content.ContentResolver
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.util.Size
import androidx.core.content.ContextCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import javax.net.ssl.HttpsURLConnection

/**
 * The phone's photos and videos for the PC's Photos page: pages of thumbnails, and the
 * original files uploaded to the PC when the user there asks for them. Only with the
 * photo permission the user grants on the phone.
 */
object PhotoLibrary {

    /** Permissions to ask for on this Android version. */
    fun permissions(): Array<String> = when {
        Build.VERSION.SDK_INT >= 34 -> arrayOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
        Build.VERSION.SDK_INT >= 33 -> arrayOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO)
        else -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
    }

    private fun granted(ctx: Context, p: String) = ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED

    /** "all", "partial" (Android 14: only photos the user picked) or "none". */
    fun access(ctx: Context): String = when {
        Build.VERSION.SDK_INT >= 33 && granted(ctx, Manifest.permission.READ_MEDIA_IMAGES) -> "all"
        Build.VERSION.SDK_INT >= 34 && granted(ctx, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) -> "partial"
        Build.VERSION.SDK_INT < 33 && granted(ctx, Manifest.permission.READ_EXTERNAL_STORAGE) -> "all"
        else -> "none"
    }

    private val COLUMNS = arrayOf(
        MediaStore.Files.FileColumns._ID, MediaStore.Files.FileColumns.MEDIA_TYPE, MediaStore.MediaColumns.DISPLAY_NAME,
        MediaStore.MediaColumns.DATE_TAKEN, MediaStore.MediaColumns.DATE_ADDED, MediaStore.MediaColumns.WIDTH,
        MediaStore.MediaColumns.HEIGHT, MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.MIME_TYPE,
        MediaStore.MediaColumns.DURATION,
    )

    private fun uriOf(video: Boolean, id: Long): Uri =
        ContentUris.withAppendedId(if (video) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)

    /** "i123" / "v456" -> content uri */
    fun uriOf(ref: String): Uri? {
        val id = ref.drop(1).toLongOrNull() ?: return null
        return when (ref.firstOrNull()) { 'i' -> uriOf(false, id); 'v' -> uriOf(true, id); else -> null }
    }

    /** kind: all | photos | videos | screenshots. Newest first. */
    /** after: only items added after this time (ms), oldest first — for auto-backup. thumbs: false skips thumbnails. */
    fun page(ctx: Context, offset: Int, limit: Int, kind: String, after: Long = 0, thumbs: Boolean = true): JSObject {
        val img = MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE
        val vid = MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO
        val type = MediaStore.Files.FileColumns.MEDIA_TYPE
        val (sel, args) = when (kind) {
            "photos" -> "$type = ?" to arrayOf("$img")
            "videos" -> "$type = ?" to arrayOf("$vid")
            "screenshots" -> "$type = ? AND (${MediaStore.MediaColumns.RELATIVE_PATH} LIKE ? OR ${MediaStore.MediaColumns.DISPLAY_NAME} LIKE ?)" to arrayOf("$img", "%Screenshot%", "Screenshot%")
            else -> "$type IN (?, ?)" to arrayOf("$img", "$vid")
        }.let { (s, a) -> if (after > 0) "($s) AND ${MediaStore.MediaColumns.DATE_ADDED} > ?" to (a + (after / 1000).toString()) else s to a }
        val q = Bundle().apply {
            putString(ContentResolver.QUERY_ARG_SQL_SELECTION, sel)
            putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, args)
            putStringArray(ContentResolver.QUERY_ARG_SORT_COLUMNS, arrayOf(MediaStore.MediaColumns.DATE_ADDED))
            putInt(ContentResolver.QUERY_ARG_SORT_DIRECTION, if (after > 0) ContentResolver.QUERY_SORT_DIRECTION_ASCENDING else ContentResolver.QUERY_SORT_DIRECTION_DESCENDING)
            putInt(ContentResolver.QUERY_ARG_LIMIT, limit + 1) // one extra: is there a next page?
            putInt(ContentResolver.QUERY_ARG_OFFSET, offset)
        }
        val items = JSArray()
        var more = false
        val cr = ctx.contentResolver
        cr.query(MediaStore.Files.getContentUri("external"), COLUMNS, q, null)?.use { c ->
            var n = 0
            while (c.moveToNext()) {
                if (n == limit) { more = true; break }
                n++
                val id = c.getLong(0)
                val video = c.getInt(1) == vid
                val taken = c.getLong(3).takeIf { it > 0 } ?: (c.getLong(4) * 1000)
                val o = JSObject()
                    .put("id", (if (video) "v" else "i") + id)
                    .put("name", c.getString(2) ?: "")
                    .put("date", taken)
                    .put("w", c.getInt(5)).put("h", c.getInt(6))
                    .put("size", c.getLong(7))
                    .put("mime", c.getString(8) ?: "")
                    .put("video", video)
                    .put("added", c.getLong(4) * 1000)
                if (video) o.put("dur", c.getLong(9) / 1000.0)
                if (thumbs) thumb(cr, uriOf(video, id))?.let { o.put("thumb", it) }
                items.put(o)
            }
        }
        return JSObject().put("items", items).put("offset", offset).put("next", if (more) offset + limit else org.json.JSONObject.NULL).put("kind", kind)
    }

    private fun thumb(cr: ContentResolver, uri: Uri): String? = try {
        val b: Bitmap = cr.loadThumbnail(uri, Size(240, 240), null)
        val out = ByteArrayOutputStream()
        b.compress(Bitmap.CompressFormat.JPEG, 72, out)
        "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    } catch (e: Exception) {
        null
    }

    /**
     * Upload the originals the PC asked for, one by one, straight from the gallery (no copies).
     * base: the PC address the app is connected to (https = pinned certificate).
     */
    fun upload(ctx: Context, refs: List<String>, base: String, key: String, token: String, from: String, progress: (Int, Int) -> Unit) {
        val cr = ctx.contentResolver
        refs.forEachIndexed { i, ref ->
            val uri = uriOf(ref) ?: return@forEachIndexed
            try {
                var name = "photo"
                var size = -1L
                var date = 0L
                cr.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DATE_TAKEN, MediaStore.MediaColumns.DATE_MODIFIED), null, null, null)?.use { c ->
                    if (c.moveToFirst()) {
                        name = c.getString(0) ?: name
                        size = c.getLong(1)
                        date = c.getLong(2).takeIf { it > 0 } ?: (c.getLong(3) * 1000)
                    }
                }
                val enc = { s: String -> URLEncoder.encode(s, "UTF-8") }
                val url = URL("$base/api/photo-upload?token=${enc(token)}&from=${enc(from)}&id=${enc(ref)}&name=${enc(name)}&mtime=$date")
                val conn = url.openConnection() as HttpURLConnection
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
                if (size > 0) conn.setFixedLengthStreamingMode(size) else conn.setChunkedStreamingMode(1 shl 16)
                (cr.openInputStream(uri) ?: throw Exception("can't open $ref")).use { input -> conn.outputStream.use { input.copyTo(it, 1 shl 16) } }
                val code = conn.responseCode
                conn.disconnect()
                if (code != 200) Log.w(TAG, "photo upload $ref: PC answered $code")
            } catch (e: Exception) {
                Log.w(TAG, "photo upload $ref failed", e)
            }
            progress(i + 1, refs.size)
        }
    }
}

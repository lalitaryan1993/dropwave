package com.dropwave.app

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import java.io.InputStream

/**
 * Saves an incoming file where people look for it: photos in Pictures/DropWave (so they show in
 * the Gallery), videos in Movies/DropWave, music in Music/DropWave, everything else in
 * Download/DropWave. No storage permission needed (MediaStore, Android 10+).
 */
object MediaSaver {
    private val UNSAFE = Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]")

    fun cleanName(raw: String?) = (raw ?: "file").replace(UNSAFE, "_").trim().take(150).ifBlank { "file" }

    fun mimeOf(name: String) =
        MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"

    /** Where a file of this type goes, for "Saved to …" lines. */
    fun folderFor(mime: String) = when {
        mime.startsWith("image/") -> "Pictures/DropWave"
        mime.startsWith("video/") -> "Movies/DropWave"
        mime.startsWith("audio/") -> "Music/DropWave"
        else -> "Download/DropWave"
    }

    /**
     * Copies len bytes (or until the end when len < 0) from input into a new file.
     * progress(doneBytes) is called as it goes. Returns the new file's uri; deletes it on failure.
     */
    fun save(ctx: Context, rawName: String, len: Long, input: InputStream, progress: (Long) -> Unit = {}): Uri {
        val name = cleanName(rawName)
        val mime = mimeOf(name)
        val (collection, dir) = when {
            mime.startsWith("image/") -> MediaStore.Images.Media.EXTERNAL_CONTENT_URI to Environment.DIRECTORY_PICTURES
            mime.startsWith("video/") -> MediaStore.Video.Media.EXTERNAL_CONTENT_URI to Environment.DIRECTORY_MOVIES
            mime.startsWith("audio/") -> MediaStore.Audio.Media.EXTERNAL_CONTENT_URI to Environment.DIRECTORY_MUSIC
            else -> MediaStore.Downloads.EXTERNAL_CONTENT_URI to Environment.DIRECTORY_DOWNLOADS
        }
        val cr = ctx.contentResolver
        val v = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, mime)
            put(MediaStore.MediaColumns.RELATIVE_PATH, "$dir/DropWave")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val item = cr.insert(collection, v) ?: throw Exception("Couldn’t create the file")
        try {
            (cr.openOutputStream(item) ?: throw Exception("Couldn’t write the file")).use { out ->
                val buf = ByteArray(1 shl 16)
                var done = 0L
                var last = 0L
                while (len < 0 || done < len) {
                    val want = if (len < 0) buf.size else minOf(buf.size.toLong(), len - done).toInt()
                    val n = input.read(buf, 0, want)
                    if (n <= 0) { if (len >= 0) throw Exception("The other phone stopped sending"); break }
                    out.write(buf, 0, n)
                    done += n
                    val now = System.currentTimeMillis()
                    if (now - last > 250) { last = now; progress(done) }
                }
                progress(done)
            }
            cr.update(item, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
            return item
        } catch (e: Exception) {
            runCatching { cr.delete(item, null, null) }
            throw e
        }
    }
}

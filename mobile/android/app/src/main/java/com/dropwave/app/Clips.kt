package com.dropwave.app

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.PersistableBundle

/**
 * Putting text from the PC on the phone's clipboard. Marked as coming from another device, so
 * Android 13+ doesn't pop up its clipboard preview ("Send to device") every time; and the same
 * text isn't set twice.
 */
object Clips {
    // In the background Android won't let DropWave read the clipboard, so remember what we put there.
    @Volatile private var lastSet: String? = null
    @Volatile private var lastAt = 0L

    @Synchronized
    fun setFromPc(ctx: Context, text: String) {
        if (text.isEmpty()) return
        val cm = ctx.getSystemService(ClipboardManager::class.java) ?: return
        val cur = runCatching { cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.text?.toString() }.getOrNull()
        if (cur == text) return
        // The same text again (the page and the native link, a reconnect, a resend): once is enough.
        if (cur == null && text == lastSet && System.currentTimeMillis() - lastAt < 10 * 60_000) return
        lastSet = text; lastAt = System.currentTimeMillis()
        val clip = ClipData.newPlainText("DropWave", text)
        if (Build.VERSION.SDK_INT >= 33) {
            clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_REMOTE_DEVICE, true) }
        }
        cm.setPrimaryClip(clip)
    }
}

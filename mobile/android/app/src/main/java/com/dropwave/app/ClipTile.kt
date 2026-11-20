package com.dropwave.app

import android.app.Activity
import android.app.PendingIntent
import android.content.ClipboardManager
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import android.widget.Toast
import com.getcapacitor.JSObject
import kotlin.concurrent.thread

/**
 * Quick Settings tile "Send clipboard": one tap sends what you copied on the phone to the PC.
 * Android only lets an app read the clipboard while it is in front, so the tile opens an invisible
 * screen for a moment, reads the clip there and closes.
 */
class ClipTile : TileService() {
    override fun onStartListening() {
        Link.restore(this)
        qsTile?.apply {
            state = if (Link.isConnected()) Tile.STATE_INACTIVE else Tile.STATE_UNAVAILABLE
            if (Build.VERSION.SDK_INT >= 29) subtitle = if (Link.isConnected()) "To your PC" else "Not connected"
            updateTile()
        }
    }

    override fun onClick() {
        val i = Intent(this, ClipSendActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 7360, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        } else {
            @Suppress("DEPRECATION", "StartActivityAndCollapseDeprecated")
            startActivityAndCollapse(i)
        }
    }
}

class ClipSendActivity : Activity() {
    private var done = false

    override fun onCreate(savedInstanceState: Bundle?) { super.onCreate(savedInstanceState) }

    // The clipboard can be read once this screen has focus.
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus || done) return
        done = true
        Link.restore(this)
        val clip = runCatching { getSystemService(ClipboardManager::class.java).primaryClip }.getOrNull()
        val text = clip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this)?.toString().orEmpty()
        val sensitive = clip?.description?.extras?.getBoolean("android.content.extra.IS_SENSITIVE") == true
        val app = applicationContext
        when {
            !Link.isConnected() -> Toast.makeText(app, "Open DropWave and connect to your PC first", Toast.LENGTH_SHORT).show()
            text.isEmpty() -> Toast.makeText(app, "The clipboard is empty", Toast.LENGTH_SHORT).show()
            sensitive -> Toast.makeText(app, "That looks like a password, so it wasn’t sent", Toast.LENGTH_SHORT).show()
            !Link.sharing("clip") -> Toast.makeText(app, "Clipboard is switched off in DropWave › Privacy", Toast.LENGTH_SHORT).show()
            else -> {
                thread { Link.post("clip", JSObject().put("text", text.take(100_000))) }
                Toast.makeText(app, "Sent to your PC", Toast.LENGTH_SHORT).show()
            }
        }
        finish()
    }
}

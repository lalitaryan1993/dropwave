package com.dropwave.app

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import android.widget.RemoteViews
import android.widget.Toast
import org.json.JSONObject
import kotlin.concurrent.thread

/** Lock the PC from anywhere on the phone: the Quick Settings tile and the widget both use this. */
object PcActions {
    fun lock(ctx: Context) {
        val app = ctx.applicationContext
        Link.restore(app)
        val main = Handler(Looper.getMainLooper())
        val say = { t: String -> main.post { Toast.makeText(app, t, Toast.LENGTH_SHORT).show() } }
        if (!Link.isConnected()) { say("Open DropWave and connect to your PC first"); return }
        thread {
            val (code, body) = Link.remote(JSONObject().put("t", "action").put("a", "lock"))
            val pc = Link.pcName(app).ifBlank { "the PC" }
            when {
                code == 200 -> say("$pc is locked")
                body.optBoolean("ask") -> say("Press Allow on $pc, then tap again")
                code == 0 -> say("Couldn’t reach $pc")
                else -> say(body.optString("error").ifBlank { "Couldn’t lock $pc" })
            }
        }
    }
}

/** Quick Settings tile "Lock PC". */
class LockPcTile : TileService() {
    override fun onStartListening() {
        Link.restore(this)
        qsTile?.apply {
            state = if (Link.isConnected()) Tile.STATE_INACTIVE else Tile.STATE_UNAVAILABLE
            if (Build.VERSION.SDK_INT >= 29) subtitle = Link.pcName(this@LockPcTile).ifBlank { if (Link.isConnected()) "Your PC" else "Not connected" }
            updateTile()
        }
    }

    override fun onClick() = PcActions.lock(this)
}

/** Home-screen widget: which PC, Send clipboard, Lock PC, Open DropWave. */
class DropWaveWidget : AppWidgetProvider() {
    override fun onUpdate(ctx: Context, mgr: AppWidgetManager, ids: IntArray) {
        for (id in ids) mgr.updateAppWidget(id, views(ctx))
    }

    override fun onReceive(ctx: Context, intent: Intent) {
        super.onReceive(ctx, intent)
        if (intent.action == ACTION_LOCK) PcActions.lock(ctx)
    }

    companion object {
        private const val ACTION_LOCK = "com.dropwave.app.widget.LOCK_PC"
        private const val FLAGS = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT

        private fun views(ctx: Context): RemoteViews {
            Link.restore(ctx)
            val pc = Link.pcName(ctx)
            return RemoteViews(ctx.packageName, R.layout.widget_dropwave).apply {
                setTextViewText(R.id.w_title, if (pc.isNotBlank()) pc else "DropWave")
                setTextViewText(R.id.w_sub, if (Link.isConnected()) "Your PC" else "Not connected")
                val open = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
                if (open != null) setOnClickPendingIntent(R.id.w_open, PendingIntent.getActivity(ctx, 7401, open, FLAGS))
                setOnClickPendingIntent(R.id.w_clip, PendingIntent.getActivity(ctx, 7402,
                    Intent(ctx, ClipSendActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), FLAGS))
                setOnClickPendingIntent(R.id.w_lock, PendingIntent.getBroadcast(ctx, 7403,
                    Intent(ctx, DropWaveWidget::class.java).setAction(ACTION_LOCK), FLAGS))
            }
        }

        /** Redraw every placed widget (after connecting to a PC). */
        fun refresh(ctx: Context) {
            val mgr = AppWidgetManager.getInstance(ctx)
            val ids = mgr.getAppWidgetIds(ComponentName(ctx, DropWaveWidget::class.java))
            if (ids.isNotEmpty()) mgr.updateAppWidget(ids, views(ctx))
        }
    }
}

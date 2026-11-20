package com.dropwave.app

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat

/**
 * Opening something on the phone for the PC. Android only lets an app open screens while it is
 * on screen (or while "Control from PC" is on); otherwise DropWave shows a notification to tap.
 */
object Launch {
    const val NOTIF_ID = 7340

    /** "opened" or "notified". */
    fun openOrNotify(ctx: Context, intent: Intent, onScreen: Boolean, title: String, text: String): String {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (onScreen || DropWavePlugin.isOnScreen()) {
            try { ctx.startActivity(intent); return "opened" } catch (_: Exception) {}
        }
        // In the background Android may silently block opening a screen, so always leave a notification
        // (and still try when "Control from PC" is on, which Android usually allows).
        val pi = PendingIntent.getActivity(ctx, NOTIF_ID, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        Notifs.post(ctx, NOTIF_ID, NotificationCompat.Builder(ctx, Notifs.CH_TRANSFERS)
            .setSmallIcon(R.drawable.ic_stat_dropwave)
            .setContentTitle(title)
            .setContentText(text)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pi))
        if (ControlService.instance != null) runCatching { ctx.startActivity(intent) }
        return "notified"
    }
}

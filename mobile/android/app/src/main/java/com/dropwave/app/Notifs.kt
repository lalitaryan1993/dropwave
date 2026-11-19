package com.dropwave.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

internal const val TAG = "DropWave"

/** System notifications: files offered by a PC (with Download / Decline) and chat messages. */
object Notifs {
    const val CH_TRANSFERS = "transfers"
    const val CH_STATUS = "status"
    const val CH_DOWNLOADS = "downloads"
    const val STATUS_ID = 1
    private const val ACCENT = 0xFF6366F1.toInt()

    fun ensureChannels(c: Context) {
        val nm = c.getSystemService(NotificationManager::class.java) ?: return
        nm.createNotificationChannel(NotificationChannel(CH_TRANSFERS, "Files and messages", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Files and messages sent to this phone"
        })
        nm.createNotificationChannel(NotificationChannel(CH_STATUS, "Connection", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Shown while DropWave stays connected to your PC in the background"
            setShowBadge(false)
        })
        nm.createNotificationChannel(NotificationChannel(CH_DOWNLOADS, "Downloads", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Progress of files being saved from your PC"
            setShowBadge(false)
        })
    }

    /** Stable int id for a string id; never collides with the status notification. */
    fun num(id: String?): Int {
        val n = (id?.hashCode() ?: 0) and 0x7fffffff
        return if (n == STATUS_ID) 2 else n
    }

    fun openApp(c: Context): PendingIntent {
        val i = Intent(c, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(c, 0, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun action(c: Context, id: String, act: String): PendingIntent {
        val i = Intent(c, NotifActionReceiver::class.java)
            .setAction("com.dropwave.app.NOTIF_$act")
            .putExtra("id", id)
            .putExtra("action", act)
        return PendingIntent.getBroadcast(c, (id + act).hashCode(), i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    fun show(c: Context, id: String, kind: String, title: String, body: String) {
        val b = NotificationCompat.Builder(c, CH_TRANSFERS)
            .setSmallIcon(R.drawable.ic_stat_dropwave)
            .setColor(ACCENT)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(if (kind == "offer") NotificationCompat.CATEGORY_EVENT else NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentIntent(openApp(c))
        if (kind == "offer") {
            b.addAction(0, "Download", action(c, id, "accept"))
            b.addAction(0, "Decline", action(c, id, "decline"))
        }
        post(c, num(id), b)
    }

    /** Notify, ignoring a missing notification permission (the feature still works without it). */
    fun post(c: Context, id: Int, b: NotificationCompat.Builder) {
        try {
            NotificationManagerCompat.from(c).notify(id, b.build())
        } catch (e: SecurityException) {
            Log.w(TAG, "notifications not allowed")
        }
    }

    fun cancel(c: Context, id: String) = NotificationManagerCompat.from(c).cancel(num(id))

    /** Clears file/message notifications (keeps the connection and download ones). */
    fun cancelAll(c: Context) {
        val nm = c.getSystemService(NotificationManager::class.java) ?: return
        nm.activeNotifications.filter { it.notification.channelId == CH_TRANSFERS }.forEach { nm.cancel(it.id) }
    }
}

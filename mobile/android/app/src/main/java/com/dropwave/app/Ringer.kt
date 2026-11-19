package com.dropwave.app

import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.getcapacitor.JSObject

/**
 * "Find my phone": the PC asks the phone to ring. Plays the alarm sound at full alarm volume
 * (so it rings on silent too) and vibrates, for up to a minute or until stopped from the
 * notification, the app, or the PC. The alarm volume is put back afterwards.
 */
@SuppressLint("StaticFieldLeak") // only ever the application context
object Ringer {
    private const val CH = "find"
    private const val NOTIF_ID = 7302
    private const val MAX_MS = 60_000L
    private var player: MediaPlayer? = null
    private var savedVolume = -1
    private val main = Handler(Looper.getMainLooper())
    private val timeout = Runnable { stop(null) }
    private var app: Context? = null

    val ringing get() = player != null

    @Synchronized
    fun start(ctx: Context) {
        val c = ctx.applicationContext.also { app = it }
        if (player != null) return
        val am = c.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        savedVolume = runCatching {
            am.getStreamVolume(AudioManager.STREAM_ALARM).also {
                am.setStreamVolume(AudioManager.STREAM_ALARM, am.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0)
            }
        }.getOrDefault(-1)
        val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM) ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
        try {
            player = MediaPlayer().apply {
                setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                setDataSource(c, uri)
                isLooping = true
                prepare()
                start()
            }
        } catch (e: Exception) {
            Log.w(TAG, "ring: ${e.message}")
        }
        c.getSystemService(Vibrator::class.java)?.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 600, 400), 0))
        showNotification(c)
        main.postDelayed(timeout, MAX_MS)
        DropWavePlugin.emit("ring", JSObject().put("on", true))
    }

    /** ctx may be null (timer). */
    @Synchronized
    fun stop(ctx: Context?) {
        main.removeCallbacks(timeout)
        val c = ctx?.applicationContext ?: app
        val was = player != null
        player?.let { runCatching { it.stop() }; it.release() }
        player = null
        if (c != null) {
            c.getSystemService(Vibrator::class.java)?.cancel()
            if (savedVolume >= 0) {
                runCatching { (c.getSystemService(Context.AUDIO_SERVICE) as AudioManager).setStreamVolume(AudioManager.STREAM_ALARM, savedVolume, 0) }
                savedVolume = -1
            }
            NotificationManagerCompat.from(c).cancel(NOTIF_ID)
        }
        if (was) DropWavePlugin.emit("ring", JSObject().put("on", false))
    }

    private fun showNotification(c: Context) {
        c.getSystemService(NotificationManager::class.java)?.createNotificationChannel(
            NotificationChannel(CH, "Find my phone", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "When your PC rings this phone"
                setSound(null, null)
            })
        val stop = Intent(c, NotifActionReceiver::class.java).setAction("com.dropwave.app.RING_STOP").putExtra("id", "ring").putExtra("action", "ring-stop")
        val pi = PendingIntent.getBroadcast(c, NOTIF_ID, stop, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        Notifs.post(c, NOTIF_ID, NotificationCompat.Builder(c, CH)
            .setSmallIcon(R.drawable.ic_stat_dropwave)
            .setContentTitle("Your PC is looking for this phone")
            .setContentText("Tap “Found it” to stop ringing")
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setOngoing(true)
            .setContentIntent(pi)
            .setDeleteIntent(pi)
            .addAction(0, "Found it", pi))
    }
}

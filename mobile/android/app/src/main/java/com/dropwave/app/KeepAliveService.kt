package com.dropwave.app

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Keeps DropWave's process (and with it the connection to the PC) alive while the app is in
 * the background, so files and messages sent from the PC still raise a notification.
 * Shows a quiet "Connected to …" notification; swiping the app away from Recents stops it.
 */
class KeepAliveService : Service() {
    private var wifiLock: WifiManager.WifiLock? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val text = intent?.getStringExtra("text")?.takeIf { it.isNotEmpty() } ?: "Connected"
        val n = NotificationCompat.Builder(this, Notifs.CH_STATUS)
            .setSmallIcon(R.drawable.ic_stat_dropwave)
            .setContentTitle(text)
            .setContentText("Ready to receive files and messages")
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(Notifs.openApp(this))
            .build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(Notifs.STATUS_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(Notifs.STATUS_ID, n)
        running = true
        if (wifiLock == null) {
            val wm = applicationContext.getSystemService(WIFI_SERVICE) as? WifiManager
            @Suppress("DEPRECATION")
            wifiLock = wm?.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "DropWave:connection")?.apply {
                setReferenceCounted(false)
                acquire()
            }
        }
        return START_NOT_STICKY // if Android kills us the page is gone too; nothing to restore
    }

    override fun onTaskRemoved(rootIntent: Intent?) = stopSelf() // the user swiped DropWave away: they want it closed

    override fun onDestroy() {
        running = false
        wifiLock?.takeIf { it.isHeld }?.release()
        wifiLock = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        @Volatile var running = false
    }
}

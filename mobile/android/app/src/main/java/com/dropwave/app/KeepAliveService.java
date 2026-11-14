package com.dropwave.app;

import android.app.Notification;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

/**
 * Keeps DropWave's process (and with it the connection to the PC) alive while the app is in
 * the background, so files and messages sent from the PC still raise a notification.
 * Shows a quiet "Connected to …" notification; swiping the app away from Recents stops it.
 */
public class KeepAliveService extends Service {
    static volatile boolean running = false;
    private WifiManager.WifiLock wifiLock;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String text = intent != null ? intent.getStringExtra("text") : null;
        if (text == null || text.isEmpty()) text = "Connected";
        Notification n = new NotificationCompat.Builder(this, Notifs.CH_STATUS)
                .setSmallIcon(R.drawable.ic_stat_dropwave)
                .setContentTitle(text)
                .setContentText("Ready to receive files and messages")
                .setOngoing(true)
                .setSilent(true)
                .setShowWhen(false)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setContentIntent(Notifs.openApp(this))
                .build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(Notifs.STATUS_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(Notifs.STATUS_ID, n);
        running = true;
        if (wifiLock == null) {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "DropWave:connection");
                wifiLock.setReferenceCounted(false);
                wifiLock.acquire();
            }
        }
        return START_NOT_STICKY; // if Android kills us the page is gone too; nothing to restore
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        stopSelf(); // the user swiped DropWave away: they want it closed
    }

    @Override
    public void onDestroy() {
        running = false;
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        wifiLock = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}

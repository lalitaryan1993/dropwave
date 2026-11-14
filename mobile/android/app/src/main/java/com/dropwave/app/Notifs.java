package com.dropwave.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

/** System notifications: files offered by a PC (with Download / Decline) and chat messages. */
final class Notifs {
    static final String CH_TRANSFERS = "transfers";
    static final String CH_STATUS = "status";
    static final int STATUS_ID = 1;
    private static final int ACCENT = 0xFF6366F1;

    private Notifs() { }

    static void ensureChannels(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel t = new NotificationChannel(CH_TRANSFERS, "Files and messages", NotificationManager.IMPORTANCE_HIGH);
        t.setDescription("Files and messages sent to this phone");
        nm.createNotificationChannel(t);
        NotificationChannel s = new NotificationChannel(CH_STATUS, "Connection", NotificationManager.IMPORTANCE_LOW);
        s.setDescription("Shown while DropWave stays connected to your PC in the background");
        s.setShowBadge(false);
        nm.createNotificationChannel(s);
    }

    /** Stable int id for a string id; never collides with the status notification. */
    static int num(String id) {
        int n = (id == null ? 0 : id.hashCode()) & 0x7fffffff;
        return n == STATUS_ID ? 2 : n;
    }

    static PendingIntent openApp(Context c) {
        Intent i = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(c, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static PendingIntent action(Context c, String id, String act) {
        Intent i = new Intent(c, NotifActionReceiver.class)
                .setAction("com.dropwave.app.NOTIF_" + act)
                .putExtra("id", id)
                .putExtra("action", act);
        return PendingIntent.getBroadcast(c, (id + act).hashCode(), i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    static void show(Context c, String id, String kind, String title, String body) {
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CH_TRANSFERS)
                .setSmallIcon(R.drawable.ic_stat_dropwave)
                .setColor(ACCENT)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory("offer".equals(kind) ? NotificationCompat.CATEGORY_EVENT : NotificationCompat.CATEGORY_MESSAGE)
                .setAutoCancel(true)
                .setContentIntent(openApp(c));
        if ("offer".equals(kind)) {
            b.addAction(0, "Download", action(c, id, "accept"));
            b.addAction(0, "Decline", action(c, id, "decline"));
        }
        try {
            NotificationManagerCompat.from(c).notify(num(id), b.build());
        } catch (SecurityException e) {
            Log.w("DropWave", "notifications not allowed", e);
        }
    }

    static void cancel(Context c, String id) {
        NotificationManagerCompat.from(c).cancel(num(id));
    }

    /** Clears file/message notifications but keeps the connection one. */
    static void cancelAll(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        for (android.service.notification.StatusBarNotification n : nm.getActiveNotifications()) {
            if (n.getId() != STATUS_ID) nm.cancel(n.getId());
        }
    }
}

package com.dropwave.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** "Download" / "Decline" buttons on a file notification: handled by the page without opening the app. */
public class NotifActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String id = intent.getStringExtra("id");
        String action = intent.getStringExtra("action");
        if (id == null || action == null) return;
        Notifs.cancel(context, id);
        DropWavePlugin.fireAction(id, action);
    }
}

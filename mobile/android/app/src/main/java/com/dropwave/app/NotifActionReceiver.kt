package com.dropwave.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Buttons on DropWave's notifications: Download / Decline (handled by the page) and "Found it". */
class NotifActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getStringExtra("id") ?: return
        val action = intent.getStringExtra("action") ?: return
        if (action == "ring-stop") { Ringer.stop(context); return } // Find my phone
        Notifs.cancel(context, id)
        DropWavePlugin.fireAction(id, action)
    }
}

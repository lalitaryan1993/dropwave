package com.dropwave.app

import android.app.Notification
import android.app.RemoteInput
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSession
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Base64
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import java.io.ByteArrayOutputStream

/**
 * Reads the phone's notifications and what's playing, for the PC ("Phone on PC").
 * Android only runs this after the user turns on notification access for DropWave in
 * system settings. Nothing is stored: each change is passed to the page, which sends it
 * to the connected PC over the local network.
 */
class PhoneListener : NotificationListenerService() {

    private val main = Handler(Looper.getMainLooper())
    private val labels = HashMap<String, String>()
    private var sessions: MediaSessionManager? = null

    override fun onListenerConnected() {
        instance = this
        Log.i(TAG, "notification listener connected")
        sessions = getSystemService(MediaSessionManager::class.java)
        try {
            sessions?.addOnActiveSessionsChangedListener({ onSessions(it) }, component(), main)
            refreshSessions()
        } catch (e: SecurityException) {
            Log.w(TAG, "media sessions: ${e.message}")
        }
        changed()
    }

    override fun onListenerDisconnected() {
        if (instance === this) instance = null
        unwatchAll()
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) { appCall(sbn, false); changed() }
    override fun onNotificationRemoved(sbn: StatusBarNotification) { appCall(sbn, true); changed() }

    // ---------- calls in apps (WhatsApp, Telegram, Signal…) ----------
    // These never reach Android's phone state; their "call" notification does, with its own
    // Answer / Decline / Hang up buttons, which the PC presses through act().

    private val appCalls = HashMap<String, String>() // notification key -> last state sent
    private val answerWords = Regex("(?i)answer|accept|pick ?up|उठा|स्वीकार")
    private val declineWords = Regex("(?i)decline|reject|dismiss|ignore|अस्वीकार")
    private val endWords = Regex("(?i)hang ?up|end|leave|disconnect|काट")

    private fun dialer(): String? = runCatching { getSystemService(android.telecom.TelecomManager::class.java)?.defaultDialerPackage }.getOrNull()

    private fun appCall(s: StatusBarNotification, removed: Boolean) {
        val n = s.notification
        if (s.packageName == packageName || s.packageName == dialer()) return
        // The same notification often turns into "Missed call" (not a call any more) when the call ends.
        if (n.category != Notification.CATEGORY_CALL) {
            if (appCalls.remove(s.key) != null) DropWavePlugin.emit("appcall", JSObject().put("key", s.key).put("state", "idle"))
            return
        }
        if (removed) {
            if (appCalls.remove(s.key) != null) DropWavePlugin.emit("appcall", JSObject().put("key", s.key).put("state", "idle"))
            return
        }
        val titles = n.actions?.map { it?.title?.toString().orEmpty() }.orEmpty()
        val idx = { re: Regex -> titles.indexOfFirst { re.containsMatchIn(it) } }
        val type = if (android.os.Build.VERSION.SDK_INT >= 31) n.extras.getInt(Notification.EXTRA_CALL_TYPE, 0) else 0
        val ringing = type == 1 || (type == 0 && idx(answerWords) >= 0)
        val state = if (ringing) "ringing" else "offhook"
        if (appCalls[s.key] == state) return
        appCalls[s.key] = state
        val caller = (n.extras.getCharSequence(Notification.EXTRA_TITLE) ?: "").toString()
        DropWavePlugin.emit("appcall", JSObject()
            .put("key", s.key).put("state", state).put("name", caller).put("app", label(s.packageName)).put("pkg", s.packageName)
            .put("answer", idx(answerWords)).put("decline", idx(declineWords)).put("end", idx(endWords)))
    }

    private fun component() = ComponentName(this, PhoneListener::class.java)

    // Many notifications arrive in bursts (a group and its summary): send one snapshot.
    private val pushNotifs = Runnable { reconcileCalls(); DropWavePlugin.emit("phoneNotifs", JSObject().put("list", snapshot())) }

    /** A call we told the PC about whose notification is gone (or no longer a call): tell the PC it ended. */
    private fun reconcileCalls() {
        if (appCalls.isEmpty()) return
        val live = try { activeNotifications?.filter { it.notification.category == Notification.CATEGORY_CALL }?.map { it.key }?.toSet() } catch (_: Exception) { null } ?: return
        for (k in appCalls.keys.toList()) if (k !in live) { appCalls.remove(k); DropWavePlugin.emit("appcall", JSObject().put("key", k).put("state", "idle")) }
    }
    private fun changed() { main.removeCallbacks(pushNotifs); main.postDelayed(pushNotifs, 350) }

    // ---------- notifications ----------

    fun snapshot(): JSArray {
        val out = JSArray()
        val all = try { activeNotifications } catch (e: Exception) { null } ?: return out
        all.sortedByDescending { it.postTime }
            .asSequence()
            .filter { it.packageName != packageName }                                   // DropWave's own
            .filter { it.notification.flags and Notification.FLAG_GROUP_SUMMARY == 0 }  // the group's children are listed
            .filter { it.notification.flags and (Notification.FLAG_ONGOING_EVENT or Notification.FLAG_FOREGROUND_SERVICE) == 0 } // music, downloads, "running"
            .mapNotNull { toJson(it) }
            .take(50)
            .forEach { out.put(it) }
        return out
    }

    private fun toJson(s: StatusBarNotification): JSObject? {
        val x: Bundle = s.notification.extras
        val title = x.getCharSequence(Notification.EXTRA_TITLE)
        val text = x.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: x.getCharSequence(Notification.EXTRA_TEXT)
        if (title == null && text == null) return null
        val actions = JSArray()
        s.notification.actions?.take(3)?.forEachIndexed { i, a ->
            if (a?.title == null) return@forEachIndexed
            val reply = a.remoteInputs?.any { it.allowFreeFormInput } == true
            actions.put(JSObject().put("i", i).put("title", a.title.toString()).put("reply", reply))
        }
        return JSObject()
            .put("key", s.key)
            .put("pkg", s.packageName)
            .put("app", label(s.packageName))
            .put("title", title?.toString() ?: "")
            .put("text", text?.toString() ?: "")
            .put("time", s.postTime)
            .put("actions", actions)
    }

    private fun label(pkg: String): String = labels.getOrPut(pkg) {
        try { packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString() } catch (e: Exception) { pkg }
    }

    private fun find(key: String): StatusBarNotification? = try { activeNotifications.firstOrNull { it.key == key } } catch (e: Exception) { null }

    /** dismiss | clear | act (button i) | reply (button i, text). */
    fun act(key: String, action: String, i: Int, text: String): Boolean {
        if (action == "clear") { cancelAllNotifications(); return true }
        val s = find(key) ?: return false
        if (action == "dismiss") { cancelNotification(key); return true }
        val a = s.notification.actions?.getOrNull(i) ?: return false
        return try {
            if (action == "reply") {
                val ri = a.remoteInputs?.takeIf { it.isNotEmpty() } ?: return false
                val fill = Intent()
                val results = Bundle().apply { ri.forEach { putCharSequence(it.resultKey, text) } }
                RemoteInput.addResultsToIntent(ri, fill, results)
                a.actionIntent.send(this, 0, fill)
            } else {
                a.actionIntent.send()
            }
            true
        } catch (e: Exception) {
            Log.w(TAG, "notification action: ${e.message}")
            false
        }
    }

    // ---------- what's playing ----------
    // Every active session is watched. Shown and controlled: the one playing now; else the one
    // that played last (paused music stays, even if its app drops it from Android's "active"
    // list); never an old stopped session that hasn't played since we started watching.

    private val watched = HashMap<MediaSession.Token, Pair<MediaController, MediaController.Callback>>()
    private var lastPlayed: MediaController? = null
    private var shown: MediaController? = null
    private var lastArtKey: String? = null
    private var lastArt: String? = null

    private fun refreshSessions() {
        try { onSessions(sessions?.getActiveSessions(component())) } catch (e: Exception) { onSessions(null) }
    }

    private fun watch(c: MediaController) {
        if (watched.containsKey(c.sessionToken)) return
        val cb = object : MediaController.Callback() {
            override fun onMetadataChanged(m: MediaMetadata?) = pick()
            override fun onPlaybackStateChanged(s: PlaybackState?) = pick()
            override fun onSessionDestroyed() {
                unwatch(c.sessionToken)
                if (lastPlayed?.sessionToken == c.sessionToken) lastPlayed = null
                refreshSessions()
            }
        }
        watched[c.sessionToken] = c to cb
        c.registerCallback(cb, main)
    }

    private fun unwatch(t: MediaSession.Token) { watched.remove(t)?.let { (c, cb) -> c.unregisterCallback(cb) } }
    private fun unwatchAll() { watched.keys.toList().forEach { unwatch(it) }; lastPlayed = null; shown = null }

    private fun onSessions(list: List<MediaController>?) {
        val active = list.orEmpty()
        val keep = active.map { it.sessionToken }.toSet() + listOfNotNull(lastPlayed?.sessionToken)
        watched.keys.filter { it !in keep }.forEach { unwatch(it) }
        active.forEach { watch(it) }
        pick()
    }

    private fun MediaController.state() = playbackState?.state ?: PlaybackState.STATE_NONE
    private fun MediaController.isPlaying() = state() == PlaybackState.STATE_PLAYING || state() == PlaybackState.STATE_BUFFERING

    private fun pick() {
        val all = watched.values.map { it.first }
        val playing = all.firstOrNull { it.isPlaying() }
        if (playing != null) lastPlayed = playing
        shown = playing
            ?: lastPlayed?.takeIf { lp -> all.any { it.sessionToken == lp.sessionToken } }
            // Nothing has played since DropWave started watching: a paused session can be resumed.
            ?: (if (lastPlayed == null) all.firstOrNull { it.state() == PlaybackState.STATE_PAUSED } else null)
        // Many callbacks arrive together (state + metadata): send one update.
        main.removeCallbacks(pushMedia)
        main.postDelayed(pushMedia, 150)
    }

    private val pushMedia = Runnable { DropWavePlugin.emit("phoneMedia", JSObject().put("media", media())) }

    fun media(): JSObject? {
        val c = shown ?: return null
        val m = c.metadata
        val st = c.playbackState
        if (c.state() == PlaybackState.STATE_STOPPED || c.state() == PlaybackState.STATE_NONE || c.state() == PlaybackState.STATE_ERROR) {
            if (!c.isPlaying() && c !== lastPlayed) return null
        }
        val title = m?.getString(MediaMetadata.METADATA_KEY_TITLE) ?: m?.getString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE)
        val artist = m?.getString(MediaMetadata.METADATA_KEY_ARTIST) ?: m?.getString(MediaMetadata.METADATA_KEY_ALBUM_ARTIST)
            ?: m?.getString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE)
        val app = label(c.packageName)
        val actions = st?.actions ?: 0L
        val o = JSObject()
            .put("title", title ?: "Playing in $app")
            .put("artist", artist ?: "")
            .put("app", app)
            .put("playing", c.isPlaying())
            .put("canSeek", actions and PlaybackState.ACTION_SEEK_TO != 0L)
            .put("canSkip", actions and (PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS) != 0L)
        val dur = m?.getLong(MediaMetadata.METADATA_KEY_DURATION) ?: 0L
        if (dur > 0) o.put("dur", dur / 1000.0)
        if (st != null && st.position >= 0) {
            var pos = st.position
            if (st.state == PlaybackState.STATE_PLAYING && st.lastPositionUpdateTime > 0) {
                pos += ((SystemClock.elapsedRealtime() - st.lastPositionUpdateTime) * st.playbackSpeed).toLong()
            }
            o.put("pos", maxOf(0L, pos) / 1000.0)
        }
        // Album art: only re-encoded when the track changes.
        val artKey = "${c.packageName}|$title|$artist"
        if (artKey != lastArtKey) {
            lastArtKey = artKey
            lastArt = (m?.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART) ?: m?.getBitmap(MediaMetadata.METADATA_KEY_ART)
                ?: m?.getBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON))?.let { art ->
                val small = Bitmap.createScaledBitmap(art, 160, maxOf(1, art.height * 160 / maxOf(1, art.width)), true)
                "data:image/jpeg;base64," + Base64.encodeToString(encode(small, Bitmap.CompressFormat.JPEG, 80), Base64.NO_WRAP)
            }
        }
        lastArt?.let { o.put("art", it) }
        return o
    }

    /** play | pause | toggle | next | prev | seek (pos in seconds). */
    fun mediaControl(action: String, pos: Double): Boolean {
        val c = shown ?: lastPlayed ?: return false
        val t = c.transportControls
        when (action) {
            "play" -> t.play()
            "pause" -> t.pause()
            "toggle" -> if (c.isPlaying()) t.pause() else t.play()
            "next" -> t.skipToNext()
            "prev" -> t.skipToPrevious()
            "seek" -> t.seekTo((maxOf(0.0, pos) * 1000).toLong())
            else -> return false
        }
        return true
    }

    companion object {
        @Volatile var instance: PhoneListener? = null
            private set

        fun enabled(ctx: Context) = NotificationManagerCompat.getEnabledListenerPackages(ctx).contains(ctx.packageName)

        /** The app's launcher icon as a small PNG data URL. */
        fun icon(ctx: Context, pkg: String): String? = try {
            val png = encode(toBitmap(ctx.packageManager.getApplicationIcon(pkg), 72), Bitmap.CompressFormat.PNG, 100)
            "data:image/png;base64," + Base64.encodeToString(png, Base64.NO_WRAP)
        } catch (e: Exception) {
            null
        }

        private fun toBitmap(d: Drawable, size: Int): Bitmap {
            if (d is BitmapDrawable && d.bitmap != null) return Bitmap.createScaledBitmap(d.bitmap, size, size, true)
            return Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888).also { b ->
                d.setBounds(0, 0, size, size)
                d.draw(Canvas(b))
            }
        }

        private fun encode(b: Bitmap, f: Bitmap.CompressFormat, q: Int): ByteArray =
            ByteArrayOutputStream().also { b.compress(f, q, it) }.toByteArray()
    }
}

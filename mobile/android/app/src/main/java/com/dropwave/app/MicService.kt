package com.dropwave.app

import android.annotation.SuppressLint
import android.app.Activity
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import com.getcapacitor.JSObject
import java.io.DataOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import javax.net.ssl.HttpsURLConnection
import kotlin.concurrent.thread

/**
 * Phone as the PC's microphone: 48 kHz mono 16-bit PCM, 20 ms per frame, streamed to the PC that
 * asked (same stream format as screen mirroring: [u32 len][u8 type][u64 pts][payload]).
 * Type 3 = format (u32 rate, u32 channels), type 6 = PCM. A notification shows it's on, with Stop.
 */
class MicService : Service() {
    data class Request(val base: String, val key: String, val token: String, val from: String)

    @Volatile private var stopping = false
    @Volatile private var gen = 0 // a new request from the PC replaces the running stream

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) { stopping = true; stopSelf(); return START_NOT_STICKY }
        val req = pending ?: run { stopSelf(); return START_NOT_STICKY }
        pending = null
        val stopPi = PendingIntent.getService(this, NOTIF_ID, Intent(this, MicService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(this, Notifs.CH_STATUS)
            .setSmallIcon(R.drawable.ic_stat_dropwave)
            .setContentTitle("Microphone is on for your PC")
            .setContentText("Your PC hears this phone’s microphone. Tap Stop to end.")
            .setOngoing(true).setSilent(true)
            .addAction(0, "Stop", stopPi)
            .setContentIntent(Notifs.openApp(this))
            .build()
        if (Build.VERSION.SDK_INT >= 30) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE) else startForeground(NOTIF_ID, n)
        running = true
        DropWavePlugin.emit("mic", JSObject().put("on", true))
        val g = ++gen
        thread(name = "dw-mic-stream") { stream(req, g) }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        stopping = true
        running = false
        DropWavePlugin.emit("mic", JSObject().put("on", false))
        super.onDestroy()
    }

    @SuppressLint("MissingPermission")
    private fun stream(req: Request, g: Int) {
        var conn: HttpURLConnection? = null
        var rec: AudioRecord? = null
        val fx = mutableListOf<android.media.audiofx.AudioEffect>()
        try {
            val enc = { s: String -> URLEncoder.encode(s, "UTF-8") }
            conn = (URL("${req.base}/api/mirror?token=${enc(req.token)}&from=${enc(req.from)}").openConnection() as HttpURLConnection).apply {
                if (this is HttpsURLConnection) {
                    sslSocketFactory = Pins.socketFactory(this@MicService)
                    setHostnameVerifier { _, _ -> true } // identity = pinned certificate
                }
                requestMethod = "POST"
                doOutput = true
                connectTimeout = 10000
                setChunkedStreamingMode(8 * 1024)
                setRequestProperty("X-DropWave-Key", req.key)
                setRequestProperty("Content-Type", "application/octet-stream")
            }
            val out = DataOutputStream(conn.outputStream.buffered(16 * 1024))
            fun frame(type: Int, pts: Long, data: ByteArray, len: Int = data.size) {
                out.writeInt(len); out.writeByte(type); out.writeLong(pts); out.write(data, 0, len); out.flush()
            }
            val chunk = RATE / 50 * 2 // 20 ms of 16-bit mono
            val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            // VOICE_COMMUNICATION: the phone's own echo cancelling and noise suppression, made for calls.
            val r = AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(min, chunk * 8))
            if (r.state != AudioRecord.STATE_INITIALIZED) throw Exception("the microphone is busy (another app may be using it)")
            rec = r
            if (NoiseSuppressor.isAvailable()) NoiseSuppressor.create(r.audioSessionId)?.let { it.enabled = true; fx.add(it) }
            if (AcousticEchoCanceler.isAvailable()) AcousticEchoCanceler.create(r.audioSessionId)?.let { it.enabled = true; fx.add(it) }
            frame(3, 0, java.nio.ByteBuffer.allocate(8).putInt(RATE).putInt(1).array())
            r.startRecording()
            val buf = ByteArray(chunk)
            while (!stopping && g == gen) {
                var got = 0
                while (got < chunk && !stopping) { val n = r.read(buf, got, chunk - got); if (n < 0) throw Exception("microphone read failed ($n)"); got += n }
                if (got == chunk) frame(6, System.nanoTime() / 1000, buf)
            }
        } catch (e: Throwable) {
            if (!stopping) { Log.w(TAG, "mic stream ended: ${e.message}"); DropWavePlugin.emit("mic", JSObject().put("on", false).put("error", "Microphone stopped: ${e.message}")) }
        } finally {
            fx.forEach { runCatching { it.release() } }
            rec?.let { runCatching { it.stop() }; runCatching { it.release() } }
            runCatching { conn?.outputStream?.close(); conn?.responseCode; conn?.disconnect() }
            if (g == gen) Handler(mainLooper).post { stopSelf() }
        }
    }

    companion object {
        private const val TAG = "DropWave"
        private const val RATE = 48000
        const val ACTION_STOP = "com.dropwave.app.MIC_STOP"
        private const val NOTIF_ID = 7351
        @Volatile var pending: Request? = null
        @Volatile var running = false

        fun stop(ctx: Context) { if (running) ctx.startService(Intent(ctx, MicService::class.java).setAction(ACTION_STOP)) }

        /** Start (from the page or the native link): on screen now, or via a notification to tap. */
        fun ask(ctx: Context, req: Request, onScreen: Boolean): String {
            pending = req
            return Launch.openOrNotify(ctx, Intent(ctx, MicActivity::class.java), onScreen, "Your PC wants to use this microphone", "Tap to turn this phone into your PC’s microphone")
        }
    }
}

/** Asks for the microphone permission if needed, then starts the mic (Android wants this while DropWave is on screen). */
class MicActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (MicService.pending == null) { finish(); return }
        if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.RECORD_AUDIO), 6)
        } else go()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) go()
        else { MicService.pending = null; DropWavePlugin.emit("mic", JSObject().put("on", false).put("error", "Microphone permission was not allowed")); finish() }
    }

    private fun go() {
        startForegroundService(Intent(this, MicService::class.java))
        finish()
    }
}

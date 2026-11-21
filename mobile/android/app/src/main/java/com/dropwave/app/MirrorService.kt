package com.dropwave.app

import android.app.Activity
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import com.getcapacitor.JSObject
import java.io.DataOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import javax.net.ssl.HttpsURLConnection
import kotlin.concurrent.thread
import kotlin.math.roundToInt

/**
 * "Phone screen on PC": captures the screen (after Android's own "Start recording or casting?"
 * consent), encodes it as H.264 with the hardware encoder and streams it to the PC that asked,
 * over the same encrypted connection. Shows a notification with Stop while it runs.
 *
 * Stream: frames of [u32 length][u8 type][u64 timestamp µs][payload]; type 0 = frame,
 * 1 = codec config (SPS/PPS), 2 = key frame, 3 = size (u32 width, u32 height).
 */
class MirrorService : Service() {

    /** What the PC asked for, waiting for the user's consent. */
    data class Request(val base: String, val key: String, val token: String, val from: String)

    private var projection: MediaProjection? = null
    @Volatile private var stopping = false
    private val main = Handler(Looper.getMainLooper())

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) { stopping = true; stopSelf(); return START_NOT_STICKY }
        val req = pending ?: run { stopSelf(); return START_NOT_STICKY }
        val code = intent?.getIntExtra("code", Activity.RESULT_CANCELED) ?: Activity.RESULT_CANCELED
        @Suppress("DEPRECATION") val data: Intent? = intent?.getParcelableExtra("data")
        if (code != Activity.RESULT_OK || data == null) { stopSelf(); return START_NOT_STICKY }
        pending = null

        val stopPi = PendingIntent.getService(this, 7310, Intent(this, MirrorService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(this, Notifs.CH_STATUS)
            .setSmallIcon(R.drawable.ic_stat_dropwave)
            .setContentTitle("Showing this screen on your PC")
            .setContentText("Tap Stop to end")
            .setOngoing(true).setSilent(true)
            .addAction(0, "Stop", stopPi)
            .setContentIntent(Notifs.openApp(this))
            .build()
        // With the microphone permission the phone's sound comes along (playback capture is an audio recording to Android).
        val mic = checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED
        val types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION or (if (mic && Build.VERSION.SDK_INT >= 30) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0)
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF_ID, n, types) else startForeground(NOTIF_ID, n)

        val mpm = getSystemService(MediaProjectionManager::class.java)
        val p = mpm.getMediaProjection(code, data) ?: run { stopSelf(); return START_NOT_STICKY }
        projection = p
        p.registerCallback(object : MediaProjection.Callback() { override fun onStop() { stopping = true } }, main)
        running = true
        DropWavePlugin.emit("mirror", JSObject().put("on", true))
        thread(name = "dropwave-mirror") { stream(req, p) }
        // Banking / UPI app in front: stop (works with Usage access; Accessibility catches it too).
        thread(name = "dropwave-mirror-guard") {
            while (!stopping) {
                Thread.sleep(1200)
                val top = Access.foregroundApp(this) ?: continue
                if (top != packageName && Access.isPaymentApp(top)) { main.post { Access.paymentAppOpened(this, top) }; break }
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        stopping = true
        // Optional: control from the PC only while the PC shows this screen.
        if (Access.prefs(this).getBoolean("controlAutoOff", false)) ControlService.instance?.off()
        runCatching { projection?.stop() }
        projection = null
        running = false
        DropWavePlugin.emit("mirror", JSObject().put("on", false).apply { stopReason?.let { put("error", it) } })
        stopReason = null
        super.onDestroy()
    }

    /** Capture size: the real screen scaled so the long side is at most 1280 (even numbers, for the encoder). */
    private fun size(): Triple<Int, Int, Int> {
        val wm = getSystemService(WindowManager::class.java)
        val b = wm.maximumWindowMetrics.bounds
        val w0 = b.width(); val h0 = b.height()
        val scale = minOf(1f, 1280f / maxOf(w0, h0))
        val w = ((w0 * scale).roundToInt() / 2) * 2
        val h = ((h0 * scale).roundToInt() / 2) * 2
        return Triple(w, h, resources.displayMetrics.densityDpi)
    }

    private fun stream(req: MirrorService.Request, p: MediaProjection) {
        var conn: HttpURLConnection? = null
        var codec: MediaCodec? = null
        var vd: VirtualDisplay? = null
        try {
            val enc = { s: String -> URLEncoder.encode(s, "UTF-8") }
            conn = (URL("${req.base}/api/mirror?token=${enc(req.token)}&from=${enc(req.from)}").openConnection() as HttpURLConnection).apply {
                if (this is HttpsURLConnection) {
                    sslSocketFactory = Pins.socketFactory(this@MirrorService)
                    setHostnameVerifier { _, _ -> true } // identity = pinned certificate
                }
                requestMethod = "POST"
                doOutput = true
                connectTimeout = 10000
                setChunkedStreamingMode(64 * 1024)
                setRequestProperty("X-DropWave-Key", req.key)
                setRequestProperty("Content-Type", "application/octet-stream")
            }
            val out = DataOutputStream(conn.outputStream.buffered(256 * 1024))
            listenForInput(req)
            // Video and audio threads share the stream: one whole frame at a time.
            fun frame(type: Int, pts: Long, data: ByteArray, off: Int = 0, len: Int = data.size) = synchronized(out) {
                out.writeInt(len); out.writeByte(type); out.writeLong(pts); out.write(data, off, len); out.flush()
            }

            var (w, h, dpi) = size()
            val info = MediaCodec.BufferInfo()
            var buf = ByteArray(256 * 1024)
            fun startEncoder() {
                val f = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, w, h).apply {
                    setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
                    setInteger(MediaFormat.KEY_BIT_RATE, 6_000_000)
                    setInteger(MediaFormat.KEY_FRAME_RATE, 60)
                    setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2)
                    setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 250_000) // a still screen still sends frames
                    setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline)
                    setInteger(MediaFormat.KEY_LEVEL, MediaCodecInfo.CodecProfileLevel.AVCLevel41)
                    if (Build.VERSION.SDK_INT >= 30) setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
                }
                val c = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
                c.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                val surface = c.createInputSurface()
                c.start()
                codec = c
                vd = vd?.apply { resize(w, h, dpi); setSurface(surface) }
                    ?: p.createVirtualDisplay("DropWave", w, h, dpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, surface, null, null)
                frame(3, 0, java.nio.ByteBuffer.allocate(8).putInt(w).putInt(h).array())
            }
            startEncoder()
            captureAudio(p) { buf, n -> frame(4, System.nanoTime() / 1000, buf, 0, n) }
            var lastCheck = 0L
            while (!stopping) {
                // Rotated? Start a new encoder at the new size (the PC reconfigures from the new SPS).
                val now = System.currentTimeMillis()
                if (now - lastCheck > 400) {
                    lastCheck = now
                    val (nw, nh, nd) = size()
                    if (nw != w || nh != h) {
                        w = nw; h = nh; dpi = nd
                        codec?.let { runCatching { it.stop() }; it.release() }
                        startEncoder()
                    }
                }
                val c = codec ?: break
                val i = c.dequeueOutputBuffer(info, 20_000)
                if (i < 0) continue
                if (info.size > 0) {
                    val bb = c.getOutputBuffer(i)!!
                    if (buf.size < info.size) buf = ByteArray(info.size * 2)
                    bb.position(info.offset); bb.get(buf, 0, info.size)
                    val type = when {
                        info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0 -> 1
                        info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0 -> 2
                        else -> 0
                    }
                    frame(type, info.presentationTimeUs, buf, 0, info.size)
                }
                c.releaseOutputBuffer(i, false)
                if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
            }
        } catch (e: Exception) {
            if (!stopping) Log.w(TAG, "mirror stream ended: ${e.message}")
        } finally {
            runCatching { vd?.release() }
            codec?.let { runCatching { it.stop() }; runCatching { it.release() } }
            runCatching { conn?.outputStream?.close(); conn?.responseCode; conn?.disconnect() }
            main.post { stopSelf() }
        }
    }

    /**
     * The phone's sound (media, games) while mirroring: Android 10+ playback capture, sent as
     * 16-bit stereo 48 kHz PCM frames (type 4). Apps that opt out of capture stay silent.
     * Needs the microphone permission (Android's rule for any audio capture).
     */
    @android.annotation.SuppressLint("MissingPermission")
    private fun captureAudio(p: MediaProjection, send: (ByteArray, Int) -> Unit) = thread(name = "dropwave-mirror-audio") {
        if (androidx.core.content.ContextCompat.checkSelfPermission(this, android.Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            Log.i(TAG, "mirror audio: microphone permission not granted, video only")
            return@thread
        }
        var rec: android.media.AudioRecord? = null
        try {
            val cfg = android.media.AudioPlaybackCaptureConfiguration.Builder(p)
                .addMatchingUsage(android.media.AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(android.media.AudioAttributes.USAGE_GAME)
                .addMatchingUsage(android.media.AudioAttributes.USAGE_UNKNOWN)
                .build()
            val fmt = android.media.AudioFormat.Builder()
                .setEncoding(android.media.AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(48000)
                .setChannelMask(android.media.AudioFormat.CHANNEL_IN_STEREO)
                .build()
            val min = android.media.AudioRecord.getMinBufferSize(48000, android.media.AudioFormat.CHANNEL_IN_STEREO, android.media.AudioFormat.ENCODING_PCM_16BIT)
            rec = android.media.AudioRecord.Builder().setAudioFormat(fmt).setBufferSizeInBytes(maxOf(min, 48000 * 4 / 5)).setAudioPlaybackCaptureConfig(cfg).build()
            rec.startRecording()
            val chunk = ByteArray(48000 * 4 / 25) // 40 ms
            while (!stopping) {
                val n = rec.read(chunk, 0, chunk.size)
                if (n > 0) send(chunk, n) else if (n < 0) break
            }
        } catch (e: Exception) {
            if (!stopping) Log.w(TAG, "mirror audio: ${e.message}")
        } finally {
            runCatching { rec?.stop() }
            rec?.release()
        }
    }

    /** Taps and keys from the PC, read directly here so control works while DropWave's page sleeps. */
    private fun listenForInput(req: Request) = thread(name = "dropwave-mirror-input") {
        var tries = 0
        while (!stopping && tries < 30) {
            try {
                val enc = { s: String -> URLEncoder.encode(s, "UTF-8") }
                val c = (URL("${req.base}/api/mirror-input?token=${enc(req.token)}&from=${enc(req.from)}").openConnection() as HttpURLConnection).apply {
                    if (this is HttpsURLConnection) {
                        sslSocketFactory = Pins.socketFactory(this@MirrorService)
                        setHostnameVerifier { _, _ -> true }
                    }
                    connectTimeout = 10000
                    readTimeout = 40000 // the PC pings every 15 s
                    setRequestProperty("X-DropWave-Key", req.key)
                }
                if (c.responseCode == 403) { Thread.sleep(300); tries++; continue } // stream not registered yet
                c.inputStream.bufferedReader().useLines { lines ->
                    for (line in lines) {
                        if (stopping) break
                        tries = 0
                        val ev = runCatching { JSObject(line) }.getOrNull() ?: continue
                        if (ev.getString("t") in setOf("hello", "ping")) continue
                        main.post { ControlService.instance?.handle(ev) }
                    }
                }
            } catch (e: Exception) {
                if (!stopping) { Log.w(TAG, "mirror input: ${e.message}"); Thread.sleep(500); tries++ }
            }
        }
    }

    companion object {
        const val ACTION_STOP = "com.dropwave.app.MIRROR_STOP"
        private const val NOTIF_ID = 7310
        @Volatile var running = false
        @Volatile var pending: Request? = null
        @Volatile var stopReason: String? = null

        fun stop(ctx: Context) {
            if (running) ctx.startService(Intent(ctx, MirrorService::class.java).setAction(ACTION_STOP))
        }
    }
}

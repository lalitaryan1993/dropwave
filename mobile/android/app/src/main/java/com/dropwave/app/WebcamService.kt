package com.dropwave.app

import android.annotation.SuppressLint
import android.app.Activity
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.SurfaceTexture
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.util.Log
import android.util.Range
import android.util.Size
import android.view.Surface
import androidx.core.app.NotificationCompat
import com.getcapacitor.JSObject
import java.io.DataOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import javax.net.ssl.HttpsURLConnection
import kotlin.concurrent.thread

/**
 * Phone as webcam: the camera, encoded as H.264, streamed to the PC that asked (same stream
 * format as screen mirroring: [u32 len][u8 type][u64 pts][payload]). Front / back can be switched
 * and the torch turned on while it runs. A notification shows it's on, with Stop.
 */
class WebcamService : Service() {
    data class Request(val base: String, val key: String, val token: String, val from: String, val front: Boolean)

    @Volatile private var stopping = false
    private val camThread = HandlerThread("dw-webcam").apply { start() }
    private val camHandler = Handler(camThread.looper)
    private var device: CameraDevice? = null
    private var session: CameraCaptureSession? = null
    private var encoderSurface: Surface? = null
    @Volatile private var front = false
    @Volatile private var torch = false
    @Volatile private var gen = 0 // a new request from the PC replaces the running stream

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) { stopping = true; stopSelf(); return START_NOT_STICKY }
        val req = pending ?: run { stopSelf(); return START_NOT_STICKY }
        pending = null
        front = req.front
        val stopPi = PendingIntent.getService(this, NOTIF_ID, Intent(this, WebcamService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(this, Notifs.CH_STATUS)
            .setSmallIcon(R.drawable.ic_stat_dropwave)
            .setContentTitle("Camera is on for your PC")
            .setContentText("This phone is your PC’s webcam. Tap Stop to end.")
            .setOngoing(true).setSilent(true)
            .addAction(0, "Stop", stopPi)
            .setContentIntent(Notifs.openApp(this))
            .build()
        if (Build.VERSION.SDK_INT >= 30) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA) else startForeground(NOTIF_ID, n)
        instance = this
        running = true
        DropWavePlugin.emit("webcam", JSObject().put("on", true).put("front", front))
        val g = ++gen
        thread(name = "dw-webcam-stream") { stream(req, g) }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        stopping = true
        closeCamera()
        camThread.quitSafely()
        if (instance === this) instance = null
        running = false
        DropWavePlugin.emit("webcam", JSObject().put("on", false))
        super.onDestroy()
    }

    // ---------- camera ----------

    private fun cams() = getSystemService(CameraManager::class.java)

    private fun pickCamera(wantFront: Boolean): String? {
        val cm = cams()
        val want = if (wantFront) CameraCharacteristics.LENS_FACING_FRONT else CameraCharacteristics.LENS_FACING_BACK
        return cm.cameraIdList.firstOrNull { cm.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == want } ?: cm.cameraIdList.firstOrNull()
    }

    /** 1280×720 when the camera has it, else the closest 16:9 size up to 1920 wide. */
    private fun pickSize(id: String): Size {
        val map = cams().getCameraCharacteristics(id).get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
        val sizes = map?.getOutputSizes(SurfaceTexture::class.java).orEmpty()
        sizes.firstOrNull { it.width == 1280 && it.height == 720 }?.let { return it }
        return sizes.filter { it.width <= 1920 && it.width * 9 == it.height * 16 }.maxByOrNull { it.width } ?: Size(1280, 720)
    }

    private fun closeCamera() {
        runCatching { session?.close() }; session = null
        runCatching { device?.close() }; device = null
    }

    @SuppressLint("MissingPermission")
    private fun openCamera(surface: Surface) {
        closeCamera()
        val id = pickCamera(front) ?: return
        cams().openCamera(id, object : CameraDevice.StateCallback() {
            override fun onOpened(d: CameraDevice) {
                if (stopping) { d.close(); return }
                device = d
                @Suppress("DEPRECATION")
                d.createCaptureSession(listOf(surface), object : CameraCaptureSession.StateCallback() {
                    override fun onConfigured(s: CameraCaptureSession) { session = s; repeat() }
                    override fun onConfigureFailed(s: CameraCaptureSession) { stage("the camera refused this video size") }
                }, camHandler)
            }
            override fun onDisconnected(d: CameraDevice) { d.close(); if (device === d) device = null }
            override fun onError(d: CameraDevice, error: Int) { stage("camera error $error (another app may be using it)"); d.close() }
        }, camHandler)
    }

    private fun repeat() {
        val d = device ?: return
        val s = session ?: return
        val surface = encoderSurface ?: return
        runCatching {
            val r = d.createCaptureRequest(CameraDevice.TEMPLATE_RECORD).apply {
                addTarget(surface)
                set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, Range(24, 30))
                set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO)
                set(CaptureRequest.FLASH_MODE, if (torch && !front) CaptureRequest.FLASH_MODE_TORCH else CaptureRequest.FLASH_MODE_OFF)
            }
            s.setRepeatingRequest(r.build(), null, camHandler)
        }
    }

    private fun stage(s: String) = DropWavePlugin.emit("webcam", JSObject().put("on", true).put("front", front).put("stage", s))

    fun switchCamera(wantFront: Boolean) { camHandler.post { if (front != wantFront) { front = wantFront; torch = false; encoderSurface?.let { openCamera(it) }; DropWavePlugin.emit("webcam", JSObject().put("on", true).put("front", front)) } } }
    fun setTorch(on: Boolean) { camHandler.post { torch = on; repeat() } }

    // ---------- stream to the PC ----------

    private fun stream(req: Request, g: Int) {
        var conn: HttpURLConnection? = null
        var codec: MediaCodec? = null
        try {
            val enc = { s: String -> URLEncoder.encode(s, "UTF-8") }
            conn = (URL("${req.base}/api/mirror?token=${enc(req.token)}&from=${enc(req.from)}").openConnection() as HttpURLConnection).apply {
                if (this is HttpsURLConnection) {
                    sslSocketFactory = Pins.socketFactory(this@WebcamService)
                    setHostnameVerifier { _, _ -> true } // identity = pinned certificate
                }
                requestMethod = "POST"
                doOutput = true
                connectTimeout = 10000
                setChunkedStreamingMode(64 * 1024)
                setRequestProperty("X-DropWave-Key", req.key)
                setRequestProperty("Content-Type", "application/octet-stream")
            }
            stage("connecting to the PC")
            val out = DataOutputStream(conn.outputStream.buffered(256 * 1024))
            fun frame(type: Int, pts: Long, data: ByteArray, off: Int = 0, len: Int = data.size) = synchronized(out) {
                out.writeInt(len); out.writeByte(type); out.writeLong(pts); out.write(data, off, len); out.flush()
            }
            stage("starting the encoder")
            val size = pickSize(pickCamera(front) ?: throw Exception("No camera"))
            val f = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, size.width, size.height).apply {
                setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
                setInteger(MediaFormat.KEY_BIT_RATE, 5_000_000)
                setInteger(MediaFormat.KEY_FRAME_RATE, 30)
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2)
                setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 200_000)
                setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline)
                setInteger(MediaFormat.KEY_LEVEL, MediaCodecInfo.CodecProfileLevel.AVCLevel41)
                if (Build.VERSION.SDK_INT >= 30) setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
            }
            val c = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
            c.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            val surface = c.createInputSurface()
            c.start()
            codec = c
            encoderSurface = surface
            // Size + which camera (the PC mirrors the front camera like a selfie view).
            frame(3, 0, java.nio.ByteBuffer.allocate(8).putInt(size.width).putInt(size.height).array())
            camHandler.post { runCatching { openCamera(surface) }.onFailure { stage("camera failed: ${it.message}") } }
            stage("waiting for the camera")

            val info = MediaCodec.BufferInfo()
            var buf = ByteArray(256 * 1024)
            while (!stopping && g == gen) {
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
            }
        } catch (e: Throwable) {
            if (!stopping) { Log.w(TAG, "webcam stream ended: ${e.message}"); DropWavePlugin.emit("webcam", JSObject().put("on", false).put("error", "Camera stream stopped: ${e.message}")) }
        } finally {
            if (g == gen) camHandler.post { closeCamera() }
            codec?.let { runCatching { it.stop() }; runCatching { it.release() } }
            runCatching { conn?.outputStream?.close(); conn?.responseCode; conn?.disconnect() }
            if (g == gen) Handler(mainLooper).post { stopSelf() }
        }
    }

    companion object {
        private const val TAG = "DropWave"
        const val ACTION_STOP = "com.dropwave.app.WEBCAM_STOP"
        private const val NOTIF_ID = 7350
        @Volatile var pending: Request? = null
        @Volatile var instance: WebcamService? = null
        @Volatile var running = false

        fun stop(ctx: Context) { if (running) ctx.startService(Intent(ctx, WebcamService::class.java).setAction(ACTION_STOP)) }

        /** Start (from the page or the native link): on screen now, or via a notification to tap. */
        fun ask(ctx: Context, req: Request, onScreen: Boolean): String {
            pending = req
            return Launch.openOrNotify(ctx, Intent(ctx, WebcamActivity::class.java), onScreen, "Your PC wants to use this camera", "Tap to turn this phone into your PC’s webcam")
        }
    }
}

/** Asks for the camera permission if needed, then starts the webcam (Android wants this while DropWave is on screen). */
class WebcamActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (WebcamService.pending == null) { finish(); return }
        if (checkSelfPermission(android.Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.CAMERA), 5)
        } else go()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) go()
        else { WebcamService.pending = null; DropWavePlugin.emit("webcam", JSObject().put("on", false).put("error", "Camera permission was not allowed")); finish() }
    }

    private fun go() {
        startForegroundService(Intent(this, WebcamService::class.java))
        finish()
    }
}

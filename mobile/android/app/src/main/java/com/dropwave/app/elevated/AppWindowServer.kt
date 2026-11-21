package com.dropwave.app.elevated

import android.content.AttributionSource
import android.content.Context
import android.content.ContextWrapper
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Build
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.view.InputDevice
import android.view.InputEvent
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.MotionEvent
import org.json.JSONObject
import java.io.DataOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import kotlin.concurrent.thread

/**
 * Elevated "app window": runs as Android's shell user (started with app_process through adb), so
 * it may create a virtual display, start any app on it, and inject touches there. The display is
 * encoded to H.264 and streamed to the PC like screen mirroring; taps come back on /api/mirror-input.
 *
 *   app_process / com.dropwave.app.elevated.AppWindowServer <base> <key> <token> <from> <package> <w> <h> <dpi>
 */
object AppWindowServer {
    @Volatile private var stopping = false
    private var displayId = -1
    private var w = 720
    private var h = 1280
    @Volatile private var lastOut = 0L
    @Volatile private var refresher: () -> Unit = {}

    @JvmStatic
    fun main(args: Array<String>) {
        if (args.size < 8) { System.err.println("usage: <base> <key> <token> <from> <package> <w> <h> <dpi>"); return }
        val (base, key, token, from, pkg) = args
        w = args[5].toInt() / 2 * 2; h = args[6].toInt() / 2 * 2
        val dpi = args[7].toInt()
        Looper.prepareMainLooper()
        val ctx = FakeContext.create()

        val enc = { s: String -> URLEncoder.encode(s, "UTF-8") }
        val conn = URL("$base/api/mirror?token=${enc(token)}&from=${enc(from)}").openConnection() as HttpURLConnection
        conn.requestMethod = "POST"; conn.doOutput = true; conn.connectTimeout = 10000
        conn.setChunkedStreamingMode(64 * 1024)
        conn.setRequestProperty("X-DropWave-Key", key)
        conn.setRequestProperty("Content-Type", "application/octet-stream")
        val out = DataOutputStream(conn.outputStream.buffered(256 * 1024))
        fun frame(type: Int, pts: Long, data: ByteArray, len: Int = data.size) = synchronized(out) {
            out.writeInt(len); out.writeByte(type); out.writeLong(pts); out.write(data, 0, len); out.flush()
        }

        val f = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, w, h).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, 5_000_000)
            setInteger(MediaFormat.KEY_FRAME_RATE, 60)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2)
            setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 200_000)
            setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline)
            setInteger(MediaFormat.KEY_LEVEL, MediaCodecInfo.CodecProfileLevel.AVCLevel41)
            // Without this some encoders (MediaTek) hold frames back, and a still app never shows up.
            if (Build.VERSION.SDK_INT >= 30) setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
        }
        val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
        codec.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        val surface = codec.createInputSurface()
        codec.start()

        // A display of our own: public (apps may start on it), trusted, own focus and touch, no lock screen.
        val flags = DisplayManager.VIRTUAL_DISPLAY_FLAG_PUBLIC or DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY or
            (1 shl 6) /* SUPPORTS_TOUCH */ or (1 shl 7) /* ROTATES_WITH_CONTENT */ or (1 shl 8) /* DESTROY_CONTENT_ON_REMOVAL */ or
            (if (Build.VERSION.SDK_INT >= 33) (1 shl 10) or (1 shl 11) or (1 shl 12) or (1 shl 13) else 0) /* TRUSTED, OWN_DISPLAY_GROUP, ALWAYS_UNLOCKED, TOUCH_FEEDBACK_DISABLED */ or
            (if (Build.VERSION.SDK_INT >= 34) (1 shl 14) else 0) /* OWN_FOCUS */
        val dm = DisplayManager::class.java.getDeclaredConstructor(Context::class.java).newInstance(ctx)
        val vd: VirtualDisplay = dm.createVirtualDisplay("DropWave $pkg", w, h, dpi, surface, flags)
        displayId = vd.display.displayId
        frame(3, 0, java.nio.ByteBuffer.allocate(8).putInt(w).putInt(h).array())
        println("display $displayId")

        // Start the app there.
        val comp = sh("cmd package resolve-activity --brief -c android.intent.category.LAUNCHER $pkg").lines().lastOrNull { it.contains('/') }?.trim()
        if (comp == null) { System.err.println("no launcher activity for $pkg"); stopping = true }
        // Not -W: if the app is already open on the phone, am may wait forever; the stream must start now.
        else thread(name = "dw-appwin-start") { sh("am start --display $displayId -f 0x18000000 -n $comp") }

        refresher = {
            // Ask for a key frame and make the display draw again (a still app produces no new frames).
            runCatching { codec.setParameters(android.os.Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) }) }
            runCatching { vd.surface = null; vd.surface = surface }
        }
        thread(name = "dw-appwin-input") { input(base, key, token, from) }
        thread(name = "dw-appwin-watch", isDaemon = true) {
            while (!stopping) {
                Thread.sleep(1000)
                if (SystemClock.uptimeMillis() - lastOut > 2000) refresher()
            }
        }

        val info = MediaCodec.BufferInfo()
        var buf = ByteArray(256 * 1024)
        var n = 0
        println("encoding"); System.out.flush()
        try {
            while (!stopping) {
                val i = codec.dequeueOutputBuffer(info, 20_000)
                if (i == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    // Some encoders (Codec2) hand over SPS/PPS here instead of as a CODEC_CONFIG buffer.
                    val of = codec.outputFormat
                    val csd = listOfNotNull(of.getByteBuffer("csd-0"), of.getByteBuffer("csd-1")).fold(ByteArray(0)) { acc, b -> acc + ByteArray(b.remaining()).also { b.duplicate().get(it) } }
                    if (csd.isNotEmpty()) frame(1, 0, csd)
                    println("format ${csd.size}"); System.out.flush()
                    continue
                }
                if (i < 0) continue
                lastOut = SystemClock.uptimeMillis()
                if (++n <= 3) { println("out ${info.flags} ${info.size}"); System.out.flush() }
                if (info.size > 0) {
                    val bb = codec.getOutputBuffer(i)!!
                    if (buf.size < info.size) buf = ByteArray(info.size * 2)
                    bb.position(info.offset); bb.get(buf, 0, info.size)
                    val type = when {
                        info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0 -> 1
                        info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0 -> 2
                        else -> 0
                    }
                    frame(type, info.presentationTimeUs, buf, info.size)
                }
                codec.releaseOutputBuffer(i, false)
            }
        } catch (e: Exception) {
            System.err.println("stream ended: ${e.message}") // the PC closed the window
        } finally {
            stopping = true
            runCatching { vd.release() } // DESTROY_CONTENT_ON_REMOVAL closes the app's window with it
            runCatching { codec.stop(); codec.release() }
            runCatching { conn.disconnect() }
        }
        Process.killProcess(Process.myPid())
    }

    private fun sh(cmd: String): String = runCatching {
        val p = Runtime.getRuntime().exec(arrayOf("sh", "-c", cmd))
        p.inputStream.bufferedReader().readText().also { p.waitFor() }
    }.getOrDefault("")

    // ---------- input from the PC window, injected on our display ----------

    private val im: Any? by lazy {
        runCatching { Class.forName("android.hardware.input.InputManagerGlobal").getMethod("getInstance").invoke(null) }.getOrNull()
            ?: runCatching { Class.forName("android.hardware.input.InputManager").getMethod("getInstance").invoke(null) }.getOrNull()
    }
    private val injectM by lazy { im?.javaClass?.getMethod("injectInputEvent", InputEvent::class.java, Int::class.javaPrimitiveType) }
    private val setDisplay by lazy { runCatching { InputEvent::class.java.getMethod("setDisplayId", Int::class.javaPrimitiveType) }.getOrNull() }

    private fun inject(e: InputEvent) {
        runCatching { setDisplay?.invoke(e, displayId) }
        runCatching { injectM?.invoke(im, e, 0 /* async */) }
    }

    private fun touch(action: Int, x: Float, y: Float, down: Long) {
        val now = SystemClock.uptimeMillis()
        val e = MotionEvent.obtain(down, now, action, x, y, 0)
        e.source = InputDevice.SOURCE_TOUCHSCREEN
        inject(e)
        e.recycle()
    }

    private fun key(code: Int) {
        val now = SystemClock.uptimeMillis()
        for (a in intArrayOf(KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP)) {
            inject(KeyEvent(now, now, a, code, 0, 0, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD))
        }
    }

    private fun handle(ev: JSONObject) {
        val px = { v: Double -> (v.coerceIn(0.0, 1.0) * (w - 1)).toFloat() }
        val py = { v: Double -> (v.coerceIn(0.0, 1.0) * (h - 1)).toFloat() }
        when (ev.optString("t")) {
            "tap", "long" -> {
                val x = px(ev.optDouble("x")); val y = py(ev.optDouble("y")); val d = SystemClock.uptimeMillis()
                touch(MotionEvent.ACTION_DOWN, x, y, d)
                Thread.sleep(if (ev.optString("t") == "long") 650 else 40)
                touch(MotionEvent.ACTION_UP, x, y, d)
            }
            "swipe" -> {
                val x1 = px(ev.optDouble("x")); val y1 = py(ev.optDouble("y")); val x2 = px(ev.optDouble("x2")); val y2 = py(ev.optDouble("y2"))
                val ms = ev.optLong("ms", 250).coerceIn(30, 2000); val steps = (ms / 16).toInt().coerceAtLeast(2); val d = SystemClock.uptimeMillis()
                touch(MotionEvent.ACTION_DOWN, x1, y1, d)
                for (s in 1..steps) { Thread.sleep(ms / steps); touch(MotionEvent.ACTION_MOVE, x1 + (x2 - x1) * s / steps, y1 + (y2 - y1) * s / steps, d) }
                touch(MotionEvent.ACTION_UP, x2, y2, d)
            }
            "refresh" -> refresher()
            "back" -> key(KeyEvent.KEYCODE_BACK)
            "enter" -> key(KeyEvent.KEYCODE_ENTER)
            "backspace" -> key(KeyEvent.KEYCODE_DEL)
            "text" -> KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD).getEvents(ev.optString("s").toCharArray())?.forEach { inject(it) }
        }
    }

    private fun input(base: String, key: String, token: String, from: String) {
        val enc = { s: String -> URLEncoder.encode(s, "UTF-8") }
        var tries = 0
        while (!stopping && tries < 30) {
            try {
                val c = URL("$base/api/mirror-input?token=${enc(token)}&from=${enc(from)}").openConnection() as HttpURLConnection
                c.connectTimeout = 10000; c.readTimeout = 40000
                c.setRequestProperty("X-DropWave-Key", key)
                if (c.responseCode == 403) { Thread.sleep(300); tries++; continue }
                c.inputStream.bufferedReader().useLines { lines ->
                    for (line in lines) {
                        if (stopping) break
                        tries = 0
                        val ev = runCatching { JSONObject(line) }.getOrNull() ?: continue
                        if (ev.optString("t") in setOf("hello", "ping")) continue
                        runCatching { handle(ev) }
                    }
                }
            } catch (_: Exception) { Thread.sleep(500); tries++ }
        }
    }
}

/** A Context for a process started by app_process as the shell user (no app around it). */
private class FakeContext(base: Context) : ContextWrapper(base) {
    override fun getPackageName() = "com.android.shell"
    override fun getOpPackageName() = "com.android.shell"
    override fun getApplicationContext(): Context = this
    override fun getAttributionSource(): AttributionSource =
        AttributionSource.Builder(Process.SHELL_UID).setPackageName("com.android.shell").build()

    companion object {
        fun create(): Context {
            val at = Class.forName("android.app.ActivityThread")
            val thread = at.getDeclaredConstructor().apply { isAccessible = true }.newInstance()
            at.getDeclaredField("sCurrentActivityThread").apply { isAccessible = true }.set(null, thread)
            runCatching { at.getDeclaredField("mSystemThread").apply { isAccessible = true }.setBoolean(thread, true) }
            val sys = at.getDeclaredMethod("getSystemContext").invoke(thread) as Context
            return FakeContext(sys)
        }
    }
}

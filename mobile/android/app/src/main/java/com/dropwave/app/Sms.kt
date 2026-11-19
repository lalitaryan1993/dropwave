package com.dropwave.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.ContactsContract
import android.provider.Telephony
import android.telephony.SmsManager
import android.util.Log
import androidx.core.content.ContextCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject

/**
 * Text messages (SMS) for the PC's Messages page: conversations, a conversation's messages,
 * sending, and new messages as they arrive. Only after the user allows SMS on the phone.
 * (RCS chats live inside Google Messages and aren't readable by other apps.)
 */
object Sms {
    fun permissions(): Array<String> = arrayOf(Manifest.permission.READ_SMS, Manifest.permission.SEND_SMS, Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_CONTACTS)

    private fun granted(ctx: Context, p: String) = ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED

    fun access(ctx: Context): String {
        val n = permissions().count { granted(ctx, it) }
        return when {
            n == permissions().size -> "all"
            granted(ctx, Manifest.permission.READ_SMS) -> "partial"
            else -> "none"
        }
    }

    private val names = HashMap<String, String?>()

    /** Contact name for a number (cached), or null. */
    fun nameFor(ctx: Context, number: String): String? {
        if (number.isBlank() || !granted(ctx, Manifest.permission.READ_CONTACTS)) return null
        return names.getOrPut(number) {
            runCatching {
                val uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number))
                ctx.contentResolver.query(uri, arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
            }.getOrNull()
        }
    }

    private val COLS = arrayOf(Telephony.Sms._ID, Telephony.Sms.THREAD_ID, Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE, Telephony.Sms.TYPE, Telephony.Sms.READ)

    private fun isOut(type: Int) = type == Telephony.Sms.MESSAGE_TYPE_SENT || type == Telephony.Sms.MESSAGE_TYPE_OUTBOX || type == Telephony.Sms.MESSAGE_TYPE_QUEUED || type == Telephony.Sms.MESSAGE_TYPE_FAILED

    /** Newest conversations first: one row per thread with its last message and unread count. */
    fun threads(ctx: Context, limit: Int): JSArray {
        val out = JSArray()
        if (!granted(ctx, Manifest.permission.READ_SMS)) return out
        data class T(val id: Long, val address: String, val snippet: String, val date: Long, val out: Boolean, var unread: Int)
        val byThread = LinkedHashMap<Long, T>()
        ctx.contentResolver.query(Telephony.Sms.CONTENT_URI, COLS, null, null, "${Telephony.Sms.DATE} DESC")?.use { c ->
            var rows = 0
            while (c.moveToNext() && rows++ < 4000) {
                val tid = c.getLong(1)
                val unread = c.getInt(6) == 0 && !isOut(c.getInt(5))
                val t = byThread[tid]
                if (t == null) {
                    if (byThread.size >= limit) continue
                    byThread[tid] = T(tid, c.getString(2) ?: "", c.getString(3) ?: "", c.getLong(4), isOut(c.getInt(5)), if (unread) 1 else 0)
                } else if (unread) t.unread++
            }
        }
        for (t in byThread.values) {
            out.put(JSObject().put("thread", t.id).put("address", t.address).put("name", nameFor(ctx, t.address) ?: "")
                .put("snippet", t.snippet.take(200)).put("date", t.date).put("out", t.out).put("unread", t.unread))
        }
        return out
    }

    /** A conversation's last messages, oldest first. */
    fun thread(ctx: Context, threadId: Long, limit: Int): JSArray {
        val list = ArrayList<JSObject>()
        if (!granted(ctx, Manifest.permission.READ_SMS)) return JSArray()
        ctx.contentResolver.query(Telephony.Sms.CONTENT_URI, COLS, "${Telephony.Sms.THREAD_ID} = ?", arrayOf(threadId.toString()), "${Telephony.Sms.DATE} DESC")?.use { c ->
            while (c.moveToNext() && list.size < limit) {
                val type = c.getInt(5)
                list.add(JSObject().put("id", c.getLong(0)).put("body", c.getString(3) ?: "").put("date", c.getLong(4)).put("out", isOut(type))
                    .put("failed", type == Telephony.Sms.MESSAGE_TYPE_FAILED).put("pending", type == Telephony.Sms.MESSAGE_TYPE_OUTBOX || type == Telephony.Sms.MESSAGE_TYPE_QUEUED))
            }
        }
        return JSArray().apply { list.asReversed().forEach { put(it) } }
    }

    /** Send with the phone's SIM. Android saves sent messages to the phone's SMS list itself. */
    @SuppressLint("MissingPermission")
    fun send(ctx: Context, address: String, text: String): String? {
        if (!granted(ctx, Manifest.permission.SEND_SMS)) return "Allow SMS in the DropWave app on the phone first"
        val to = address.trim()
        if (to.isEmpty() || text.isBlank()) return "Nothing to send"
        return try {
            val sm = ctx.getSystemService(SmsManager::class.java)
            val parts = sm.divideMessage(text)
            if (parts.size > 1) sm.sendMultipartTextMessage(to, null, parts, null, null) else sm.sendTextMessage(to, null, text, null, null)
            null
        } catch (e: Exception) {
            Log.w(TAG, "sms send: ${e.message}")
            e.message ?: "Couldn’t send"
        }
    }

    /** SMS_RECEIVED: tell the page (one event per sender, long messages joined). */
    fun onReceived(ctx: Context, intent: Intent) {
        val msgs = runCatching { Telephony.Sms.Intents.getMessagesFromIntent(intent) }.getOrNull() ?: return
        msgs.filterNotNull().groupBy { it.originatingAddress ?: "" }.forEach { (from, parts) ->
            DropWavePlugin.emit("sms", JSObject().put("address", from).put("name", nameFor(ctx, from) ?: "")
                .put("body", parts.joinToString("") { it.messageBody ?: "" }).put("date", parts.first().timestampMillis))
        }
    }
}

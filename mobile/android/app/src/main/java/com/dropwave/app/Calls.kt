package com.dropwave.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.provider.CallLog
import android.provider.ContactsContract
import android.net.Uri
import android.telecom.TelecomManager
import android.telephony.TelephonyManager
import android.util.Log
import androidx.core.content.ContextCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject

/**
 * Phone calls for the PC: who's calling (ringing / on a call / ended), Answer / Decline / Hang up
 * from the PC, and recent calls. Only after the user allows the Phone and Call log permissions.
 * The caller's name comes from the call log's cached contact name (no contacts permission needed).
 */
object Calls {
    fun permissions(): Array<String> = arrayOf(Manifest.permission.READ_PHONE_STATE, Manifest.permission.READ_CALL_LOG, Manifest.permission.ANSWER_PHONE_CALLS, Manifest.permission.CALL_PHONE)

    private val DIALABLE = Regex("^[+]?[0-9*#]{2,20}$")

    /** Call a number with the phone's SIM. Telecom places it, so it works with DropWave in the background. */
    @SuppressLint("MissingPermission")
    fun dial(ctx: Context, raw: String): String? {
        val number = raw.replace(Regex("[\\s().-]"), "")
        if (!DIALABLE.matches(number)) return "That doesn’t look like a phone number"
        if (!granted(ctx, Manifest.permission.CALL_PHONE)) return "Allow calls in the DropWave app on the phone first"
        val tm = ctx.getSystemService(TelecomManager::class.java) ?: return "This phone can’t make calls"
        return try {
            lastNumber = number // Android doesn't tell us the number of an outgoing call
            tm.placeCall(Uri.fromParts("tel", number, null), android.os.Bundle())
            null
        } catch (e: Exception) {
            Log.w(TAG, "dial: ${e.message}")
            e.message ?: "Couldn’t place the call"
        }
    }

    private fun granted(ctx: Context, p: String) = ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED

    /** "all" (state, number, log, answer), "partial" (some allowed) or "none". */
    fun access(ctx: Context): String {
        val n = permissions().count { granted(ctx, it) }
        return when (n) { permissions().size -> "all"; 0 -> "none"; else -> "partial" }
    }

    private var lastState: String? = null
    private var lastNumber: String? = null

    /** From the system's phone-state broadcast. Emits "call" when the state or the number changes. */
    fun onPhoneState(ctx: Context, i: Intent) {
        val state = when (i.getStringExtra(TelephonyManager.EXTRA_STATE)) {
            TelephonyManager.EXTRA_STATE_RINGING -> "ringing"
            TelephonyManager.EXTRA_STATE_OFFHOOK -> "offhook"
            TelephonyManager.EXTRA_STATE_IDLE -> "idle"
            else -> return
        }
        @Suppress("DEPRECATION")
        val number = i.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER) ?: if (state == "idle") null else lastNumber
        if (state == lastState && number == lastNumber) return
        lastState = state
        lastNumber = number
        val o = JSObject().put("state", state).put("at", System.currentTimeMillis())
        if (number != null) {
            o.put("number", number)
            nameFor(ctx, number)?.let { o.put("name", it) }
        }
        DropWavePlugin.emit("call", o)
    }

    fun current(): JSObject? = lastState?.takeIf { it != "idle" }?.let { s ->
        JSObject().put("state", s).apply { lastNumber?.let { put("number", it) } }
    }

    /** Contact name: from contacts if allowed, else the name the call log cached for this number. */
    private fun nameFor(ctx: Context, number: String): String? {
        if (granted(ctx, Manifest.permission.READ_CONTACTS)) {
            runCatching {
                val uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number))
                ctx.contentResolver.query(uri, arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) return c.getString(0) }
            }
        }
        if (!granted(ctx, Manifest.permission.READ_CALL_LOG)) return null
        return runCatching {
            ctx.contentResolver.query(CallLog.Calls.CONTENT_URI, arrayOf(CallLog.Calls.CACHED_NAME),
                "${CallLog.Calls.NUMBER} = ? AND ${CallLog.Calls.CACHED_NAME} IS NOT NULL AND ${CallLog.Calls.CACHED_NAME} != ''", arrayOf(number),
                "${CallLog.Calls.DATE} DESC")?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
        }.getOrNull()
    }

    /** answer | decline | end. */
    @SuppressLint("MissingPermission")
    fun act(ctx: Context, action: String): Boolean {
        if (!granted(ctx, Manifest.permission.ANSWER_PHONE_CALLS)) return false
        val tm = ctx.getSystemService(TelecomManager::class.java) ?: return false
        return try {
            @Suppress("DEPRECATION")
            when (action) {
                "answer" -> { tm.acceptRingingCall(); true }
                "decline", "end" -> tm.endCall()
                else -> false
            }
        } catch (e: Exception) {
            Log.w(TAG, "call $action: ${e.message}")
            false
        }
    }

    /** Recent calls, newest first. type: in | out | missed | rejected | blocked */
    @SuppressLint("MissingPermission")
    fun log(ctx: Context, limit: Int): JSArray {
        val out = JSArray()
        if (!granted(ctx, Manifest.permission.READ_CALL_LOG)) return out
        val cols = arrayOf(CallLog.Calls._ID, CallLog.Calls.NUMBER, CallLog.Calls.CACHED_NAME, CallLog.Calls.TYPE, CallLog.Calls.DATE, CallLog.Calls.DURATION)
        val q = android.os.Bundle().apply {
            putStringArray(android.content.ContentResolver.QUERY_ARG_SORT_COLUMNS, arrayOf(CallLog.Calls.DATE))
            putInt(android.content.ContentResolver.QUERY_ARG_SORT_DIRECTION, android.content.ContentResolver.QUERY_SORT_DIRECTION_DESCENDING)
            putInt(android.content.ContentResolver.QUERY_ARG_LIMIT, limit)
        }
        ctx.contentResolver.query(CallLog.Calls.CONTENT_URI, cols, q, null)?.use { c ->
            while (c.moveToNext() && out.length() < limit) { // the call log ignores QUERY_ARG_LIMIT
                val type = when (c.getInt(3)) {
                    CallLog.Calls.INCOMING_TYPE -> "in"
                    CallLog.Calls.OUTGOING_TYPE -> "out"
                    CallLog.Calls.MISSED_TYPE -> "missed"
                    CallLog.Calls.REJECTED_TYPE -> "rejected"
                    CallLog.Calls.BLOCKED_TYPE -> "blocked"
                    else -> "in"
                }
                out.put(JSObject()
                    .put("id", c.getLong(0))
                    .put("number", c.getString(1) ?: "")
                    .put("name", c.getString(2) ?: "")
                    .put("type", type)
                    .put("date", c.getLong(4))
                    .put("dur", c.getLong(5)))
            }
        }
        return out
    }
}

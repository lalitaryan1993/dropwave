package com.dropwave.app

import android.content.ContentUris
import android.content.Context
import android.provider.ContactsContract
import android.provider.ContactsContract.CommonDataKinds.Email
import android.provider.ContactsContract.CommonDataKinds.Phone
import android.util.Base64
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import org.json.JSONArray

/** The phone's contacts for the PC: names, numbers, emails; photos one at a time. Needs READ_CONTACTS. */
object Contacts {
    fun list(ctx: Context, limit: Int = 5000): JSObject {
        val byId = LinkedHashMap<Long, JSObject>()
        ctx.contentResolver.query(
            Phone.CONTENT_URI,
            arrayOf(Phone.CONTACT_ID, Phone.DISPLAY_NAME_PRIMARY, Phone.NUMBER, Phone.TYPE, Phone.LABEL, Phone.STARRED, Phone.PHOTO_THUMBNAIL_URI),
            null, null, "${Phone.DISPLAY_NAME_PRIMARY} COLLATE NOCASE ASC",
        )?.use { c ->
            while (c.moveToNext() && byId.size < limit) {
                val id = c.getLong(0)
                val num = c.getString(2)?.trim().orEmpty()
                if (num.isEmpty()) continue
                val o = byId.getOrPut(id) {
                    JSObject().put("id", id).put("name", c.getString(1) ?: num).put("starred", c.getInt(5) == 1)
                        .put("photo", c.getString(6) != null).put("numbers", JSONArray()).put("emails", JSONArray())
                }
                val label = Phone.getTypeLabel(ctx.resources, c.getInt(3), c.getString(4) ?: "").toString()
                val arr = o.getJSONArray("numbers")
                val norm = num.filter { it.isDigit() || it == '+' }
                val dup = (0 until arr.length()).any { i -> arr.getJSONObject(i).getString("n").filter { it.isDigit() || it == '+' } == norm }
                if (!dup) arr.put(JSObject().put("n", num).put("t", label))
            }
        }
        if (byId.isNotEmpty()) ctx.contentResolver.query(Email.CONTENT_URI, arrayOf(Email.CONTACT_ID, Email.ADDRESS), null, null, null)?.use { c ->
            while (c.moveToNext()) {
                val a = c.getString(1) ?: continue
                byId[c.getLong(0)]?.getJSONArray("emails")?.put(a)
            }
        }
        val out = JSArray()
        byId.values.forEach { out.put(it) }
        return JSObject().put("list", out)
    }

    fun photo(ctx: Context, id: Long): String? = try {
        val uri = ContentUris.withAppendedId(ContactsContract.Contacts.CONTENT_URI, id)
        ContactsContract.Contacts.openContactPhotoInputStream(ctx.contentResolver, uri, false)?.use {
            "data:image/jpeg;base64," + Base64.encodeToString(it.readBytes(), Base64.NO_WRAP)
        }
    } catch (_: Exception) { null }
}

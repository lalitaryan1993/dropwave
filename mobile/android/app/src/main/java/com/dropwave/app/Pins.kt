package com.dropwave.app

import android.annotation.SuppressLint
import android.content.Context
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.X509TrustManager

/**
 * Certificates of paired PCs, pinned by SHA-256 fingerprint (trust on first use).
 * Each PC uses its own self-signed certificate; a connection is trusted only if the PC
 * presents exactly a certificate the user paired with.
 */
object Pins {
    private const val PREFS = "dropwave_pins"
    private const val KEY = "fps"
    private val HEX64 = Regex("[0-9a-f]{64}")

    private fun prefs(c: Context) = c.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun add(c: Context, fp: String?) {
        if (fp == null || !HEX64.matches(fp)) return
        val set = prefs(c).getStringSet(KEY, emptySet()).orEmpty() + fp
        prefs(c).edit().putStringSet(KEY, set).apply()
    }

    fun fingerprint(cert: X509Certificate): String = try {
        MessageDigest.getInstance("SHA-256").digest(cert.encoded).joinToString("") { "%02x".format(it) }
    } catch (e: Exception) {
        ""
    }

    fun isPinned(c: Context, cert: X509Certificate?): Boolean =
        cert != null && prefs(c).getStringSet(KEY, emptySet()).orEmpty().contains(fingerprint(cert))

    /** TLS sockets that accept only a pinned certificate (used for downloads outside the WebView). */
    fun socketFactory(c: Context): SSLSocketFactory {
        val app = c.applicationContext
        @SuppressLint("CustomX509TrustManager")
        val tm = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>?, authType: String?) = throw CertificateException("not used")
            override fun checkServerTrusted(chain: Array<X509Certificate>?, authType: String?) {
                if (chain.isNullOrEmpty() || !isPinned(app, chain[0])) {
                    throw CertificateException("This PC's certificate is not the one DropWave paired with")
                }
            }
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        return SSLContext.getInstance("TLS").apply { init(null, arrayOf(tm), null) }.socketFactory
    }
}

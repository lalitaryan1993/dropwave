package com.dropwave.app

import android.net.http.SslError
import android.util.Log
import android.webkit.SslErrorHandler
import android.webkit.WebView
import com.getcapacitor.Bridge
import com.getcapacitor.BridgeWebViewClient

/**
 * Lets the WebView talk HTTPS to a paired PC's self-signed certificate, and nothing else:
 * a certificate is accepted only if its fingerprint was pinned when the user paired.
 */
class PinningWebViewClient(bridge: Bridge) : BridgeWebViewClient(bridge) {
    override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
        val cert = error.certificate?.x509Certificate
        if (Pins.isPinned(view.context, cert)) {
            handler.proceed()
        } else {
            Log.w(TAG, "refused an unknown certificate for ${error.url}")
            handler.cancel()
        }
    }
}

package com.dropwave.app;

import android.net.http.SslError;
import android.util.Log;
import android.webkit.SslErrorHandler;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import java.security.cert.X509Certificate;

/**
 * Lets the WebView talk HTTPS to a paired PC's self-signed certificate, and nothing else:
 * a certificate is accepted only if its fingerprint was pinned when the user paired.
 */
public class PinningWebViewClient extends BridgeWebViewClient {
    public PinningWebViewClient(Bridge bridge) {
        super(bridge);
    }

    @Override
    public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
        X509Certificate cert = error.getCertificate() != null ? error.getCertificate().getX509Certificate() : null;
        if (Pins.isPinned(view.getContext(), cert)) {
            handler.proceed();
        } else {
            Log.w("DropWave", "refused an unknown certificate for " + error.getUrl());
            handler.cancel();
        }
    }
}

package com.dropwave.app;

import android.content.Context;
import android.content.SharedPreferences;

import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.HashSet;
import java.util.Set;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * Certificates of paired PCs, pinned by SHA-256 fingerprint (trust on first use).
 * Each PC uses its own self-signed certificate; a connection is trusted only if the PC
 * presents exactly a certificate the user paired with.
 */
final class Pins {
    private static final String PREFS = "dropwave_pins";
    private static final String KEY = "fps";

    private Pins() { }

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static void add(Context c, String fp) {
        if (fp == null || !fp.matches("[0-9a-f]{64}")) return;
        Set<String> s = new HashSet<>(prefs(c).getStringSet(KEY, new HashSet<>()));
        s.add(fp);
        prefs(c).edit().putStringSet(KEY, s).apply();
    }

    static String fingerprint(X509Certificate cert) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(cert.getEncoded());
            StringBuilder sb = new StringBuilder();
            for (byte b : d) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    static boolean isPinned(Context c, X509Certificate cert) {
        return cert != null && prefs(c).getStringSet(KEY, new HashSet<>()).contains(fingerprint(cert));
    }

    /** TLS sockets that accept only a pinned certificate (used for downloads outside the WebView). */
    static SSLSocketFactory socketFactory(Context c) throws Exception {
        final Context app = c.getApplicationContext();
        X509TrustManager tm = new X509TrustManager() {
            @Override public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                throw new CertificateException("not used");
            }
            @Override public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                if (chain == null || chain.length == 0 || !isPinned(app, chain[0])) {
                    throw new CertificateException("This PC's certificate is not the one DropWave paired with");
                }
            }
            @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        };
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, new TrustManager[]{tm}, null);
        return ctx.getSocketFactory();
    }
}

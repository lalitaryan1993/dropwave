package com.dropwave.app;

import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Log;
import android.webkit.MimeTypeMap;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;

import javax.net.ssl.HttpsURLConnection;

/**
 * Downloads a file from a paired PC over HTTPS (pinned certificate) into Download/DropWave.
 * Android's DownloadManager can't be used here: it only trusts certificate authorities.
 * Shows its own progress / done notification; tapping "done" opens the file.
 */
final class PinnedDownload {
    private PinnedDownload() { }

    static void start(Context ctx, String url, String name) {
        final Context c = ctx.getApplicationContext();
        new Thread(() -> run(c, url, name), "dropwave-download").start();
    }

    private static void run(Context c, String url, String name) {
        int nid = Notifs.num("dl:" + url);
        NotificationManagerCompat nm = NotificationManagerCompat.from(c);
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, Notifs.CH_DOWNLOADS)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle(name)
                .setContentText("Downloading…")
                .setOnlyAlertOnce(true)
                .setOngoing(true)
                .setProgress(100, 0, true);
        post(nm, nid, b);

        ContentResolver cr = c.getContentResolver();
        Uri item = null;
        HttpsURLConnection conn = null;
        try {
            conn = (HttpsURLConnection) new URL(url).openConnection();
            conn.setSSLSocketFactory(Pins.socketFactory(c));
            conn.setHostnameVerifier((host, session) -> true); // identity = pinned certificate, not a hostname
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(60000);
            if (conn.getResponseCode() != 200) throw new Exception("PC answered " + conn.getResponseCode());
            long total = conn.getContentLengthLong();
            String mime = mimeFor(name, conn.getContentType());

            ContentValues v = new ContentValues();
            v.put(MediaStore.Downloads.DISPLAY_NAME, name);
            v.put(MediaStore.Downloads.MIME_TYPE, mime);
            v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/DropWave");
            v.put(MediaStore.Downloads.IS_PENDING, 1);
            item = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (item == null) throw new Exception("Couldn't create the file in Downloads");

            try (InputStream in = conn.getInputStream(); OutputStream out = cr.openOutputStream(item)) {
                if (out == null) throw new Exception("Couldn't write to Downloads");
                byte[] buf = new byte[1 << 16];
                long done = 0, lastUi = 0;
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    done += n;
                    long now = System.currentTimeMillis();
                    if (now - lastUi > 500 && total > 0) {
                        lastUi = now;
                        b.setProgress(100, (int) (done * 100 / total), false);
                        post(nm, nid, b);
                    }
                }
            }
            ContentValues fin = new ContentValues();
            fin.put(MediaStore.Downloads.IS_PENDING, 0);
            cr.update(item, fin, null, null);

            Intent view = new Intent(Intent.ACTION_VIEW).setDataAndType(item, mime)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            PendingIntent open = PendingIntent.getActivity(c, nid, view, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            post(nm, nid, new NotificationCompat.Builder(c, Notifs.CH_DOWNLOADS)
                    .setSmallIcon(android.R.drawable.stat_sys_download_done)
                    .setContentTitle(name)
                    .setContentText("Saved to Download/DropWave")
                    .setContentIntent(open)
                    .setAutoCancel(true));
            Log.i("DropWave", "downloaded " + name);
        } catch (Exception e) {
            Log.w("DropWave", "download failed: " + name, e);
            if (item != null) { try { cr.delete(item, null, null); } catch (Exception ignored) { } }
            post(nm, nid, new NotificationCompat.Builder(c, Notifs.CH_DOWNLOADS)
                    .setSmallIcon(android.R.drawable.stat_notify_error)
                    .setContentTitle(name)
                    .setContentText("Download failed: " + e.getMessage())
                    .setAutoCancel(true));
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String mimeFor(String name, String header) {
        if (header != null && !header.isEmpty() && !header.startsWith("application/octet-stream")) return header.split(";")[0].trim();
        int dot = name.lastIndexOf('.');
        String m = dot >= 0 ? MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase()) : null;
        return m != null ? m : "application/octet-stream";
    }

    private static void post(NotificationManagerCompat nm, int id, NotificationCompat.Builder b) {
        try { nm.notify(id, b.build()); } catch (SecurityException ignored) { /* notifications off: download still happens */ }
    }
}

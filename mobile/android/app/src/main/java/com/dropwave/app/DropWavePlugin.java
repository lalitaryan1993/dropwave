package com.dropwave.app;

import android.app.DownloadManager;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.provider.OpenableColumns;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Native helpers for the DropWave app:
 *  - download(url, name): save a file to Download/DropWave with the system DownloadManager
 *  - takeShared(): files/text shared into the app from other apps ("Share -> DropWave")
 *  - minimize(): send the app to the background (used for the Back button)
 *  - localIps(): this phone's IPv4 addresses, to scan the Wi-Fi for PCs
 * Emits "shared" when something is shared while the app is already open.
 */
@CapacitorPlugin(name = "DropWave")
public class DropWavePlugin extends Plugin {

    private JSObject pendingShare = null;

    @Override
    public void load() {
        Intent intent = getActivity().getIntent();
        if (isShare(intent)) collectShare(intent, false);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (isShare(intent)) collectShare(intent, true);
    }

    private static boolean isShare(Intent intent) {
        if (intent == null) return false;
        String a = intent.getAction();
        return Intent.ACTION_SEND.equals(a) || Intent.ACTION_SEND_MULTIPLE.equals(a);
    }

    // Copy shared content:// files into the app cache so the web layer can read them.
    private void collectShare(final Intent intent, final boolean notify) {
        new Thread(() -> {
            JSObject data = new JSObject();
            JSArray files = new JSArray();
            List<Uri> uris = new ArrayList<>();
            if (Intent.ACTION_SEND.equals(intent.getAction())) {
                Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (u != null) uris.add(u);
            } else {
                ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (list != null) uris.addAll(list);
            }
            File dir = new File(getContext().getCacheDir(), "shared/" + System.currentTimeMillis());
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            ContentResolver cr = getContext().getContentResolver();
            for (Uri u : uris) {
                try {
                    String name = displayName(cr, u);
                    File out = new File(dir, name);
                    try (InputStream in = cr.openInputStream(u); OutputStream os = new FileOutputStream(out)) {
                        if (in == null) continue;
                        byte[] buf = new byte[1 << 16];
                        int n;
                        while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                    }
                    JSObject f = new JSObject();
                    f.put("path", out.getAbsolutePath());
                    f.put("name", name);
                    f.put("type", cr.getType(u) != null ? cr.getType(u) : "application/octet-stream");
                    f.put("size", out.length());
                    files.put(f);
                } catch (Exception ignored) { }
            }
            data.put("files", files);
            String text = intent.getStringExtra(Intent.EXTRA_TEXT);
            data.put("text", text != null && uris.isEmpty() ? text : "");
            pendingShare = data;
            if (notify) notifyListeners("shared", data, true);
        }).start();
    }

    private static String displayName(ContentResolver cr, Uri u) {
        String name = null;
        try (Cursor c = cr.query(u, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) name = c.getString(0);
        } catch (Exception ignored) { }
        if (name == null) name = u.getLastPathSegment();
        if (name == null || name.isEmpty()) name = "shared-file";
        return name.replaceAll("[\\\\/:*?\"<>|]", "_");
    }

    @PluginMethod
    public void takeShared(PluginCall call) {
        JSObject d = pendingShare;
        pendingShare = null;
        call.resolve(d != null ? d : new JSObject().put("files", new JSArray()).put("text", ""));
    }

    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        String name = call.getString("name", "download");
        if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) {
            call.reject("Bad URL");
            return;
        }
        try {
            String safe = name.replaceAll("[\\\\/:*?\"<>|]", "_");
            DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url))
                    .setTitle(safe)
                    .setDescription("DropWave")
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "DropWave/" + safe);
            DownloadManager dm = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
            long id = dm.enqueue(r);
            call.resolve(new JSObject().put("id", id));
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void minimize(PluginCall call) {
        getActivity().runOnUiThread(() -> getActivity().moveTaskToBack(true));
        call.resolve();
    }

    @PluginMethod
    public void localIps(PluginCall call) {
        JSArray ips = new JSArray();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback() || ni.isVirtual()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a instanceof Inet4Address && !a.isLoopbackAddress() && !a.isLinkLocalAddress()) {
                        ips.put(new JSObject().put("address", a.getHostAddress()).put("iface", ni.getName()));
                    }
                }
            }
        } catch (Exception ignored) { }
        call.resolve(new JSObject().put("ips", ips));
    }
}

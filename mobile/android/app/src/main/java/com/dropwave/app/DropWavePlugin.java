package com.dropwave.app;

import android.app.DownloadManager;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.provider.OpenableColumns;
import android.util.Log;

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
 *  - showNotification / cancelNotify: system notifications for files and messages from the PC
 *  - keepAlive: foreground service that keeps the connection open in the background
 * Emits "shared" when something is shared while the app is already open, and
 * "notifAction" when a notification's Download/Decline button is tapped.
 */
@CapacitorPlugin(name = "DropWave")
public class DropWavePlugin extends Plugin {

    private static final String TAG = "DropWave";

    private JSObject pendingShare = null;
    private static DropWavePlugin instance;

    @Override
    public void load() {
        instance = this;
        Notifs.ensureChannels(getContext());
        Intent intent = getActivity().getIntent();
        if (isShare(intent)) collectShare(intent, false);
    }

    /** A Download/Decline tap on a notification, passed to the page as "notifAction". */
    static void fireAction(String id, String action) {
        DropWavePlugin p = instance;
        if (p == null) return;
        Log.i(TAG, "notification action " + action + " for " + id);
        p.notifyListeners("notifAction", new JSObject().put("id", id).put("action", action), true);
    }

    // ---------- notifications ----------

    // Whether DropWave is on screen. Tracked here because the page's visibilityState isn't reliable:
    // Capacitor keeps the WebView running in the background, so it can still say "visible".
    private static volatile boolean onScreen = true;

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        onScreen = true;
        Notifs.cancelAll(getContext()); // the page shows everything now
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        onScreen = false;
    }

    @PluginMethod
    public void showNotification(PluginCall call) {
        String id = call.getString("id", "dropwave");
        Log.i(TAG, "notification " + call.getString("kind") + " " + id + (onScreen ? " (on screen: skipped)" : ""));
        if (onScreen) { call.resolve(new JSObject().put("shown", false)); return; } // the page's own cards/toasts show it
        Notifs.show(getContext(), id, call.getString("kind", "text"), call.getString("title", "DropWave"), call.getString("body", ""));
        call.resolve();
    }

    @PluginMethod
    public void cancelNotify(PluginCall call) {
        String id = call.getString("id");
        if (id != null) Notifs.cancel(getContext(), id);
        else Notifs.cancelAll(getContext());
        call.resolve();
    }

    /** on=true: stay connected in the background (and ask for the notification permission once). */
    @PluginMethod
    public void keepAlive(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", true));
        Context ctx = getContext();
        Intent i = new Intent(ctx, KeepAliveService.class).putExtra("text", call.getString("text", "Connected"));
        try {
            if (on) {
                askNotificationPermission();
                ctx.startForegroundService(i);
            } else {
                ctx.stopService(i);
            }
            call.resolve();
        } catch (Exception e) {
            // Android 12+ refuses to start a foreground service while the app is in the background.
            Log.w(TAG, "keepAlive(" + on + ") failed", e);
            call.reject(e.getMessage());
        }
    }

    private void askNotificationPermission() {
        if (android.os.Build.VERSION.SDK_INT < 33) return;
        String p = android.Manifest.permission.POST_NOTIFICATIONS;
        if (androidx.core.content.ContextCompat.checkSelfPermission(getContext(), p) == android.content.pm.PackageManager.PERMISSION_GRANTED) return;
        android.content.SharedPreferences sp = getContext().getSharedPreferences("dropwave", Context.MODE_PRIVATE);
        if (sp.getBoolean("askedNotif", false)) return; // ask once; after that it's in Android settings
        sp.edit().putBoolean("askedNotif", true).apply();
        androidx.core.app.ActivityCompat.requestPermissions(getActivity(), new String[]{p}, 7301);
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
        Log.i(TAG, "share intent: " + intent.getAction() + " type=" + intent.getType() + " notify=" + notify);
        new Thread(() -> {
            JSObject data = new JSObject();
            JSArray files = new JSArray();
            JSArray errors = new JSArray();
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
                    Log.i(TAG, "shared file copied: " + name + " (" + out.length() + " bytes)");
                } catch (Exception e) {
                    Log.w(TAG, "could not read shared item " + u, e);
                    errors.put(String.valueOf(e.getMessage()));
                }
            }
            data.put("files", files);
            data.put("errors", errors);
            String text = intent.getStringExtra(Intent.EXTRA_TEXT);
            data.put("text", text != null && uris.isEmpty() ? text : "");
            pendingShare = data;
            Log.i(TAG, "share ready: " + files.length() + " file(s), notify=" + notify);
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
        Log.i(TAG, "download " + name);
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

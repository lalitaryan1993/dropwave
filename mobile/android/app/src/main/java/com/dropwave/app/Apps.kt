package com.dropwave.app

import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.provider.Settings
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import java.io.File

/** Apps on the phone (the ones with an icon in the launcher): list, open, info, uninstall, APK copy. */
object Apps {
    fun list(ctx: Context): JSObject {
        val pm = ctx.packageManager
        val seen = HashSet<String>()
        val out = JSArray()
        val main = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        for (ri in pm.queryIntentActivities(main, 0)) {
            val pkg = ri.activityInfo.packageName
            if (pkg == ctx.packageName || !seen.add(pkg)) continue
            try {
                val pi = pm.getPackageInfo(pkg, 0)
                val ai = pi.applicationInfo ?: continue
                val system = ai.flags and ApplicationInfo.FLAG_SYSTEM != 0 && ai.flags and ApplicationInfo.FLAG_UPDATED_SYSTEM_APP == 0
                out.put(JSObject()
                    .put("pkg", pkg)
                    .put("name", ri.loadLabel(pm).toString())
                    .put("version", pi.versionName ?: "")
                    .put("system", system)
                    .put("installed", pi.firstInstallTime)
                    .put("updated", pi.lastUpdateTime)
                    .put("size", File(ai.sourceDir).length() + (ai.splitSourceDirs?.sumOf { File(it).length() } ?: 0L))
                    .put("apk", ai.splitSourceDirs.isNullOrEmpty())) // a single APK can be copied and installed elsewhere
            } catch (_: Exception) {}
        }
        return JSObject().put("list", out)
    }

    fun openIntent(ctx: Context, pkg: String): Intent? = ctx.packageManager.getLaunchIntentForPackage(pkg)
    fun infoIntent(pkg: String) = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$pkg"))
    @Suppress("DEPRECATION")
    fun uninstallIntent(pkg: String) = Intent(Intent.ACTION_UNINSTALL_PACKAGE, Uri.parse("package:$pkg"))

    fun label(ctx: Context, pkg: String): String = try {
        ctx.packageManager.getApplicationLabel(ctx.packageManager.getApplicationInfo(pkg, 0)).toString()
    } catch (_: Exception) { pkg }

    private val BAD = Regex("[\\\\/:*?\"<>|]")

    /** The installable APK (only for apps that are one file). */
    fun apk(ctx: Context, pkg: String): Pair<File, String>? = try {
        val pi = ctx.packageManager.getPackageInfo(pkg, 0)
        val ai = pi.applicationInfo!!
        if (!ai.splitSourceDirs.isNullOrEmpty()) null
        else Pair(File(ai.sourceDir), ("${label(ctx, pkg)} ${pi.versionName ?: ""}").replace(BAD, "").trim() + ".apk")
    } catch (_: Exception) { null }
}

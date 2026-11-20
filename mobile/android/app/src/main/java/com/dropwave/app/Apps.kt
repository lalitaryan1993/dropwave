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
    /** "Usage access" (Android settings): lets DropWave see when apps were last used. */
    fun usageAllowed(ctx: Context): Boolean {
        val ops = ctx.getSystemService(android.app.AppOpsManager::class.java)
        @Suppress("DEPRECATION")
        val mode = ops.checkOpNoThrow(android.app.AppOpsManager.OPSTR_GET_USAGE_STATS, android.os.Process.myUid(), ctx.packageName)
        return mode == android.app.AppOpsManager.MODE_ALLOWED
    }

    /** Last used time and time on screen (7 days) per app, when usage access is allowed. */
    private fun usage(ctx: Context): Map<String, Pair<Long, Long>> {
        if (!usageAllowed(ctx)) return emptyMap()
        val usm = ctx.getSystemService(android.app.usage.UsageStatsManager::class.java)
        val now = System.currentTimeMillis()
        val out = HashMap<String, Pair<Long, Long>>()
        runCatching {
            usm.queryUsageStats(android.app.usage.UsageStatsManager.INTERVAL_BEST, now - 7L * 86_400_000, now).forEach { s ->
                val old = out[s.packageName]
                out[s.packageName] = Pair(maxOf(old?.first ?: 0, s.lastTimeUsed), (old?.second ?: 0) + s.totalTimeInForeground)
            }
        }
        return out
    }

    fun usageIntent() = Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)

    fun list(ctx: Context): JSObject {
        val pm = ctx.packageManager
        val used = usage(ctx)
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
                    .put("apk", ai.splitSourceDirs.isNullOrEmpty()) // a single APK can be copied and installed elsewhere
                    .put("lastUsed", used[pkg]?.first ?: 0L)
                    .put("usedMs", used[pkg]?.second ?: 0L))
            } catch (_: Exception) {}
        }
        return JSObject().put("list", out).put("usage", usageAllowed(ctx))
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

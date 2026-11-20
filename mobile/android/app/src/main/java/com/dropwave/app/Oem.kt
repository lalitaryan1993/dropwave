package com.dropwave.app

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings

/**
 * Phone makers that stop background apps on their own (beyond Android's battery rules), and the
 * page in their settings where DropWave can be let run. Tried in order; the app info page if none opens.
 */
object Oem {
    fun brand(): String {
        val m = (Build.MANUFACTURER + " " + Build.BRAND).lowercase()
        return when {
            "xiaomi" in m || "redmi" in m || "poco" in m -> "xiaomi"
            "realme" in m -> "realme"
            "oppo" in m -> "oppo"
            "oneplus" in m -> "oneplus"
            "vivo" in m || "iqoo" in m -> "vivo"
            "samsung" in m -> "samsung"
            "huawei" in m || "honor" in m -> "huawei"
            "motorola" in m -> "motorola"
            else -> "other"
        }
    }

    private val PAGES = mapOf(
        "xiaomi" to listOf("com.miui.securitycenter" to "com.miui.permcenter.autostart.AutoStartManagementActivity"),
        "realme" to listOf(
            "com.oplus.battery" to "com.oplus.powermanager.fuelgaue.PowerUsageModelActivity",
            "com.coloros.safecenter" to "com.coloros.safecenter.startupapp.StartupAppListActivity",
            "com.coloros.safecenter" to "com.coloros.privacypermissionsentry.PermissionTopActivity",
        ),
        "oppo" to listOf(
            "com.coloros.safecenter" to "com.coloros.safecenter.startupapp.StartupAppListActivity",
            "com.oplus.battery" to "com.oplus.powermanager.fuelgaue.PowerUsageModelActivity",
        ),
        "oneplus" to listOf("com.oneplus.security" to "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity"),
        "vivo" to listOf(
            "com.vivo.permissionmanager" to "com.vivo.permissionmanager.activity.BgStartUpManagerActivity",
            "com.iqoo.secure" to "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager",
        ),
        "samsung" to listOf("com.samsung.android.lool" to "com.samsung.android.sm.battery.ui.BatteryActivity"),
        "huawei" to listOf("com.huawei.systemmanager" to "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
    )

    /** Opens the maker's background / autostart page. Returns "maker" or "appinfo". */
    fun openBackgroundPage(ctx: Context, from: android.app.Activity?): String {
        val start: (Intent) -> Boolean = { i ->
            runCatching { if (from != null) from.startActivity(i) else ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }.isSuccess
        }
        for ((pkg, cls) in PAGES[brand()].orEmpty()) {
            val i = Intent().setComponent(ComponentName(pkg, cls))
            if (i.resolveActivity(ctx.packageManager) != null && start(i)) return "maker"
        }
        start(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${ctx.packageName}")))
        return "appinfo"
    }
}

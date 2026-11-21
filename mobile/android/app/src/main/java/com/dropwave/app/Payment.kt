package com.dropwave.app

/** Banking / UPI / payment apps: control from the PC switches off, screen sharing stops, and they never open in a PC window.
 * Kept free of Android context so the shell-user helper (elevated/) can use it too. */
object Payment {
    private val PAYMENT_APPS = setOf(
        "com.phonepe.app", "net.one97.paytm", "com.google.android.apps.nbu.paisa.user", "in.org.npci.upiapp",
        "com.sbi.lotusintouch", "com.sbi.SBIFreedomPlus", "com.snapwork.hdfc", "com.csam.icici.bank.imobile", "com.axis.mobile",
        "com.msf.kbank.mobile", "com.mobikwik_new", "com.freecharge.android",
        "com.dreamplug.androidapp", "com.bankofbaroda.mconnect", "com.infrasofttech.mahabank", "com.canarabank.mobility",
        "com.unionbank.ecommerce.mobile.android", "com.pnb.mobile", "com.idbibank.abhay_card", "com.fss.indus", "com.rbl.mobank",
        "com.yesbank", "com.federalbank.fedmobile", "com.whatsapp.w4b.payments", "com.paypal.android.p2pmobile",
    )
    private val PAYMENT_WORDS = Regex("(?i)(bank|upi|wallet|payments?|\\.pay\\.|paisa|banking|finance|trading|broker|zerodha|groww|upstox)")

    fun isPaymentApp(pkg: String) = pkg in PAYMENT_APPS || PAYMENT_WORDS.containsMatchIn(pkg)
}

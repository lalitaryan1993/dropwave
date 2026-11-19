package com.dropwave.app

import android.os.Bundle
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(DropWavePlugin::class.java) // must be registered before the bridge starts
        super.onCreate(savedInstanceState)
        // HTTPS to paired PCs: accept their pinned self-signed certificates, nothing else.
        bridge.webViewClient = PinningWebViewClient(bridge)
    }
}

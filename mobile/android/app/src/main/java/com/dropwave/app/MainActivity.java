package com.dropwave.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DropWavePlugin.class); // must be registered before the bridge starts
        super.onCreate(savedInstanceState);
    }
}

package com.lggram.tailnetrelay;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!ProfileMode.isManagedProfile(context)) {
            return;
        }
        Intent serviceIntent = new Intent(context, SocksRelayService.class)
                .setAction(SocksRelayService.ACTION_START);
        context.startForegroundService(serviceIntent);
    }
}

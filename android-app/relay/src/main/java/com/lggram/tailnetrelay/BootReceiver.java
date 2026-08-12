package com.lggram.tailnetrelay;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

public final class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "TailnetRelay";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!ProfileMode.isManagedProfile(context)
                || intent == null
                || !shouldStartForAction(intent.getAction())) {
            return;
        }
        Intent serviceIntent = new Intent(context, SocksRelayService.class)
                .setAction(SocksRelayService.ACTION_START);
        try {
            context.startForegroundService(serviceIntent);
        } catch (RuntimeException error) {
            // Android/HyperOS can briefly reject a foreground-service start
            // while a managed profile is still becoming available. Keep the
            // broadcast receiver short and retry from an inexact idle-safe
            // alarm instead of losing the relay until the next reboot.
            Log.w(TAG, "Foreground relay start was deferred", error);
            RelayRestartScheduler.scheduleStartRetry(context);
        }
    }

    static boolean shouldStartForAction(String action) {
        return Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_USER_UNLOCKED.equals(action)
                || Intent.ACTION_MANAGED_PROFILE_AVAILABLE.equals(action)
                || Intent.ACTION_MANAGED_PROFILE_UNLOCKED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                || RelayRestartScheduler.ACTION_WATCHDOG.equals(action);
    }
}

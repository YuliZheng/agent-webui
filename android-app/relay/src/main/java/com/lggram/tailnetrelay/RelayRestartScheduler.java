package com.lggram.tailnetrelay;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.SystemClock;

final class RelayRestartScheduler {
    static final String ACTION_WATCHDOG =
            "com.lggram.tailnetrelay.action.WATCHDOG";
    static final long REGULAR_DELAY_MS = 15 * 60_000L;
    static final long TASK_REMOVED_DELAY_MS = 2_000L;
    static final long START_RETRY_DELAY_MS = 60_000L;

    private static final int REQUEST_CODE = 7301;

    private RelayRestartScheduler() {
    }

    static void scheduleRegular(Context context) {
        schedule(context, REGULAR_DELAY_MS);
    }

    static void scheduleAfterTaskRemoved(Context context) {
        schedule(context, TASK_REMOVED_DELAY_MS);
    }

    static void scheduleStartRetry(Context context) {
        schedule(context, START_RETRY_DELAY_MS);
    }

    static void cancel(Context context) {
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        if (alarms != null) alarms.cancel(pendingIntent(context));
    }

    private static void schedule(Context context, long delayMs) {
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        if (alarms == null) return;
        alarms.setAndAllowWhileIdle(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                SystemClock.elapsedRealtime() + Math.max(1, delayMs),
                pendingIntent(context));
    }

    private static PendingIntent pendingIntent(Context context) {
        Intent intent = new Intent(context, BootReceiver.class)
                .setAction(ACTION_WATCHDOG);
        return PendingIntent.getBroadcast(
                context,
                REQUEST_CODE,
                intent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }
}

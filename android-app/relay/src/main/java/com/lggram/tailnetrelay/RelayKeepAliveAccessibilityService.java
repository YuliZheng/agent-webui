package com.lggram.tailnetrelay;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.CrossProfileApps;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.os.UserHandle;
import android.util.Log;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityManager;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Opt-in personal-profile watchdog for HyperOS process cleanup.
 *
 * <p>The service is deliberately restricted in the XML metadata to events from
 * this package, cannot retrieve window content, and never inspects an event.
 * Android does not bind third-party accessibility services inside a managed
 * profile, so the personal-profile instance probes the loopback health endpoint
 * and uses CrossProfileApps to reopen the same package in the work profile when
 * recovery is needed.</p>
 */
public final class RelayKeepAliveAccessibilityService extends AccessibilityService {
    private static final String TAG = "TailnetRelay";
    private static final String ACTION_ACCESSIBILITY_DETAILS_SETTINGS =
            "android.settings.ACCESSIBILITY_DETAILS_SETTINGS";
    private static final String HEALTH_URL = "http://127.0.0.1:38484/health";
    private static final long PROBE_INTERVAL_MS = 60_000L;
    private static final long RECOVERY_COOLDOWN_MS = 2 * 60_000L;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Runnable healthProbe = this::runHealthProbe;
    private boolean firstProbeAfterBind;
    private int consecutiveFailures;
    private long lastRecoveryAt = Long.MIN_VALUE;

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        if (ProfileMode.isManagedProfile(this)) {
            Log.w(TAG, "Android does not support the keep-alive accessibility service in a managed profile");
            disableSelf();
            return;
        }

        firstProbeAfterBind = true;
        consecutiveFailures = 0;
        handler.removeCallbacks(healthProbe);
        handler.post(healthProbe);
        Log.i(TAG, "Personal accessibility watchdog connected");
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // Intentionally empty. This service never reads accessibility events.
    }

    @Override
    public void onInterrupt() {
        // No feedback is produced, so there is nothing to interrupt.
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(healthProbe);
        executor.shutdownNow();
        super.onDestroy();
    }

    private void runHealthProbe() {
        try {
            executor.execute(() -> {
                boolean healthy = probeRelay();
                handler.post(() -> handleProbeResult(healthy));
            });
        } catch (RuntimeException error) {
            Log.w(TAG, "Accessibility watchdog probe was rejected", error);
        }
    }

    private boolean probeRelay() {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(HEALTH_URL).openConnection();
            connection.setConnectTimeout(1_500);
            connection.setReadTimeout(1_500);
            connection.setRequestMethod("GET");
            connection.setUseCaches(false);
            return connection.getResponseCode() == HttpURLConnection.HTTP_OK;
        } catch (IOException error) {
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void handleProbeResult(boolean healthy) {
        if (healthy) {
            consecutiveFailures = 0;
        } else {
            consecutiveFailures += 1;
            if (firstProbeAfterBind || consecutiveFailures >= 2) {
                recoverWorkProfileRelay();
                consecutiveFailures = 0;
            }
        }
        firstProbeAfterBind = false;
        handler.removeCallbacks(healthProbe);
        handler.postDelayed(healthProbe, PROBE_INTERVAL_MS);
    }

    private void recoverWorkProfileRelay() {
        long now = SystemClock.elapsedRealtime();
        if (lastRecoveryAt != Long.MIN_VALUE
                && now - lastRecoveryAt < RECOVERY_COOLDOWN_MS) {
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            Log.w(TAG, "Cross-profile relay recovery requires Android 9 or newer");
            return;
        }

        CrossProfileApps crossProfileApps = getSystemService(CrossProfileApps.class);
        if (crossProfileApps == null) return;
        List<UserHandle> targets = crossProfileApps.getTargetUserProfiles();
        if (targets.isEmpty()) {
            Log.w(TAG, "No work-profile Tailnet Relay installation is available for recovery");
            return;
        }

        ComponentName relayActivity = new ComponentName(this, RelayActivity.class);
        try {
            crossProfileApps.startMainActivity(relayActivity, targets.get(0));
            lastRecoveryAt = now;
            Log.i(TAG, "Accessibility watchdog launched the work-profile relay");
        } catch (RuntimeException error) {
            Log.w(TAG, "Accessibility watchdog could not launch the work-profile relay", error);
        }
    }

    static boolean isEnabled(Context context) {
        AccessibilityManager manager = context.getSystemService(AccessibilityManager.class);
        if (manager == null || !manager.isEnabled()) return false;

        ComponentName expected = new ComponentName(
                context,
                RelayKeepAliveAccessibilityService.class);
        List<AccessibilityServiceInfo> enabled = manager.getEnabledAccessibilityServiceList(
                AccessibilityServiceInfo.FEEDBACK_ALL_MASK);
        for (AccessibilityServiceInfo info : enabled) {
            if (expected.flattenToString().equals(info.getId())) return true;
        }
        return false;
    }

    static Intent settingsIntent(Context context) {
        Intent intent = new Intent(ACTION_ACCESSIBILITY_DETAILS_SETTINGS);
        intent.setData(android.net.Uri.parse("package:" + context.getPackageName()));
        return intent;
    }
}

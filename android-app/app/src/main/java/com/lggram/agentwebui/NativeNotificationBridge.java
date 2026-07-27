package com.lggram.agentwebui;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Build;
import android.os.SystemClock;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.Deque;

final class NativeNotificationBridge {
    static final int PERMISSION_REQUEST_CODE = 7301;
    static final String EXTRA_NOTIFICATION_TAG = "agent_notification_tag";

    private static final String CHANNEL_ID = "agent_replies";
    private static final int MAX_TEXT_LENGTH = 200;
    private static final int MAX_TAG_LENGTH = 128;
    private static final int MAX_NOTIFICATIONS_PER_MINUTE = 12;
    private static final String PREFERENCES_NAME = "native_permissions";
    private static final String NOTIFICATION_PERMISSION_ASKED = "notification_asked";

    private final Activity activity;
    private final WebView webView;
    private final NotificationManager notificationManager;
    private final Deque<Long> notificationTimes = new ArrayDeque<>();
    private String pendingPermissionRequestId;

    NativeNotificationBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        this.notificationManager =
                (NotificationManager) activity.getSystemService(Context.NOTIFICATION_SERVICE);
        createNotificationChannel();
    }

    @JavascriptInterface
    public String getNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            SharedPreferences preferences =
                    activity.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE);
            return preferences.getBoolean(NOTIFICATION_PERMISSION_ASKED, false)
                    ? "denied"
                    : "default";
        }
        if (!notificationManager.areNotificationsEnabled()) return "denied";
        return "granted";
    }

    @JavascriptInterface
    public void requestNotificationPermission(String requestId) {
        final String safeRequestId = limit(requestId, 64);
        activity.runOnUiThread(() -> {
            pendingPermissionRequestId = safeRequestId;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                    && activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                activity.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
                        .edit()
                        .putBoolean(NOTIFICATION_PERMISSION_ASKED, true)
                        .apply();
                activity.requestPermissions(
                        new String[] { Manifest.permission.POST_NOTIFICATIONS },
                        PERMISSION_REQUEST_CODE
                );
                return;
            }
            dispatchPermissionResult(safeRequestId, getNotificationPermission());
            pendingPermissionRequestId = null;
        });
    }

    @JavascriptInterface
    public void showNotification(String title, String body, String tag) {
        final String safeTitle = limit(title, MAX_TEXT_LENGTH);
        final String safeBody = limit(body, MAX_TEXT_LENGTH);
        final String safeTag = limit(tag, MAX_TAG_LENGTH);
        activity.runOnUiThread(() -> {
            if (!"granted".equals(getNotificationPermission())) return;
            if (!consumeRateLimit()) return;

            Intent openIntent = new Intent(activity, MainActivity.class)
                    .setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    .putExtra(EXTRA_NOTIFICATION_TAG, safeTag);
            PendingIntent contentIntent = PendingIntent.getActivity(
                    activity,
                    safeTag.hashCode(),
                    openIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );

            Notification notification = new Notification.Builder(activity, CHANNEL_ID)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setColor(Color.rgb(80, 93, 246))
                    .setContentTitle(safeTitle.isEmpty() ? activity.getString(R.string.app_name) : safeTitle)
                    .setContentText(safeBody)
                    .setStyle(new Notification.BigTextStyle().bigText(safeBody))
                    .setContentIntent(contentIntent)
                    .setAutoCancel(true)
                    .setCategory(Notification.CATEGORY_MESSAGE)
                    .setVisibility(Notification.VISIBILITY_PRIVATE)
                    .build();
            notificationManager.notify(safeTag, 1, notification);
        });
    }

    @JavascriptInterface
    public void closeNotification(String tag) {
        final String safeTag = limit(tag, MAX_TAG_LENGTH);
        activity.runOnUiThread(() -> notificationManager.cancel(safeTag, 1));
    }

    @JavascriptInterface
    public void setSystemBarAppearance(
            boolean lightStatusBar,
            boolean lightNavigationBar
    ) {
        activity.runOnUiThread(() -> {
            if (activity instanceof MainActivity) {
                ((MainActivity) activity).applySystemBarAppearance(
                        lightStatusBar,
                        lightNavigationBar
                );
            }
        });
    }

    void onRequestPermissionsResult(int requestCode) {
        if (requestCode != PERMISSION_REQUEST_CODE) return;
        String requestId = pendingPermissionRequestId;
        pendingPermissionRequestId = null;
        if (requestId != null) {
            dispatchPermissionResult(requestId, getNotificationPermission());
        }
    }

    private void createNotificationChannel() {
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                activity.getString(R.string.notification_channel_name),
                NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription(activity.getString(R.string.notification_channel_description));
        notificationManager.createNotificationChannel(channel);
    }

    private void dispatchPermissionResult(String requestId, String result) {
        String script = "window.__agentNativeDispatchPermission&&"
                + "window.__agentNativeDispatchPermission("
                + JSONObject.quote(requestId) + "," + JSONObject.quote(result) + ");";
        webView.post(() -> webView.evaluateJavascript(script, null));
    }

    private boolean consumeRateLimit() {
        long now = SystemClock.elapsedRealtime();
        long cutoff = now - 60_000L;
        while (!notificationTimes.isEmpty() && notificationTimes.peekFirst() < cutoff) {
            notificationTimes.removeFirst();
        }
        if (notificationTimes.size() >= MAX_NOTIFICATIONS_PER_MINUTE) return false;
        notificationTimes.addLast(now);
        return true;
    }

    private static String limit(String value, int maxLength) {
        if (value == null) return "";
        String normalized = value.replace('\u0000', ' ').trim();
        return normalized.length() <= maxLength
                ? normalized
                : normalized.substring(0, maxLength);
    }
}

package com.lggram.tailnetrelay;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

@SuppressLint("SetTextI18n")
public final class RelayActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private TextView statusView;
    private boolean managedProfile;

    private final Runnable refreshStatus = new Runnable() {
        @Override
        public void run() {
            updateStatus();
            handler.postDelayed(this, 1_000);
        }
    };

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        managedProfile = ProfileMode.isManagedProfile(this);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int padding = dp(24);
        root.setPadding(padding, dp(40), padding, padding);

        TextView title = new TextView(this);
        title.setText(managedProfile ? "Tailnet Relay" : "Agent WebUI");
        title.setTextSize(30);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        root.addView(title, matchWrap());

        TextView explanation = new TextView(this);
        explanation.setText(managedProfile
                ? "Single work-profile relay for Agent WebUI.\n\n"
                        + "Windows bridge: " + BridgePolicy.LISTEN_HOST + ":"
                        + RelayTarget.WINDOWS.bridgePort + "\n"
                        + "MacBook bridge: " + BridgePolicy.LISTEN_HOST + ":"
                        + RelayTarget.MACBOOK.bridgePort + "\n"
                        + "SOCKS compatibility: " + RelayPolicy.LISTEN_HOST + ":"
                        + RelayPolicy.LISTEN_PORT + "\n"
                        + "Tailnet targets: Windows + MacBook\n\n"
                        + "Personal Chrome can open "
                        + RelayTarget.WINDOWS.launchOrigin() + "/ or "
                        + RelayTarget.MACBOOK.launchOrigin()
                        + RelayTarget.MACBOOK.launchPath + " directly. Only the two "
                        + "configured Agent WebUI hosts are accepted."
                : "No personal-profile relay service is needed in version 1.4.\n\n"
                        + "Keep Tailnet Relay and Tailscale running in the work profile, "
                        + "then open:\n\n"
                        + RelayTarget.WINDOWS.launchOrigin() + "/ (Windows)\n"
                        + RelayTarget.MACBOOK.launchOrigin()
                        + RelayTarget.MACBOOK.launchPath + " (agent-macbook)\n\n"
                        + "This uses no personal VPN slot and can run together "
                        + "with personal-profile FlClash.");
        explanation.setTextSize(16);
        explanation.setPadding(0, dp(20), 0, dp(24));
        root.addView(explanation, matchWrap());

        statusView = new TextView(this);
        statusView.setTextSize(17);
        statusView.setPadding(dp(16), dp(16), dp(16), dp(16));
        root.addView(statusView, matchWrap());

        Button start = new Button(this);
        start.setText(managedProfile ? "Start relay" : "Open Windows Agent");
        start.setOnClickListener(view -> {
            if (managedProfile) {
                startRelay();
            } else {
                openAgentWebUi(RelayTarget.WINDOWS);
            }
        });
        root.addView(start, matchWrap());

        Button openMacbook = new Button(this);
        openMacbook.setText("Install / open agent-macbook in Chrome");
        openMacbook.setOnClickListener(view -> openAgentWebUi(RelayTarget.MACBOOK));
        if (managedProfile) {
            openMacbook.setVisibility(View.GONE);
        }
        root.addView(openMacbook, matchWrap());

        Button stop = new Button(this);
        stop.setText("Stop relay");
        stop.setOnClickListener(view -> stopRelay());
        if (!managedProfile) {
            stop.setVisibility(View.GONE);
        }
        root.addView(stop, matchWrap());

        setContentView(root);
        if (managedProfile) {
            startRelay();
        }
    }

    @Override
    protected void onStart() {
        super.onStart();
        handler.post(refreshStatus);
    }

    @Override
    protected void onStop() {
        handler.removeCallbacks(refreshStatus);
        super.onStop();
    }

    private void startRelay() {
        Intent intent = new Intent(this, SocksRelayService.class)
                .setAction(SocksRelayService.ACTION_START);
        startForegroundService(intent);
        handler.postDelayed(this::updateStatus, 250);
    }

    private void stopRelay() {
        if (!managedProfile) {
            return;
        }
        Intent intent = new Intent(this, SocksRelayService.class)
                .setAction(SocksRelayService.ACTION_STOP);
        startService(intent);
        handler.postDelayed(this::updateStatus, 250);
    }

    private void openAgentWebUi(RelayTarget target) {
        Uri uri = Uri.parse(target.launchOrigin() + target.launchPath);
        Intent browser = new Intent(Intent.ACTION_VIEW, uri);
        if (target.forceChrome) {
            // Android WebAPK intent filters omit the loopback port. The Mac
            // launcher therefore uses localhost instead of the Windows app's
            // 127.0.0.1 origin and explicitly opens Chrome for installation.
            browser.setPackage("com.android.chrome");
        }
        try {
            startActivity(browser);
        } catch (ActivityNotFoundException error) {
            browser.setPackage(null);
            startActivity(browser);
        }
    }

    private void updateStatus() {
        if (!managedProfile) {
            statusView.setText(
                    "Personal background service: not required\n"
                            + "Required: work Tailnet Relay + work Tailscale");
            return;
        }

        StringBuilder status = new StringBuilder();
        status.append(SocksRelayService.isRunning()
                ? "Status: running"
                : "Status: starting or stopped");
        status.append("\nMode: work SOCKS + two Web bridges");
        status.append("\nActive connections: ")
                .append(SocksRelayService.activeConnections());
        status.append("\nTotal connections: ")
                .append(SocksRelayService.totalConnections());
        String error = SocksRelayService.lastError();
        if (error != null && !error.isEmpty()) {
            status.append("\nLast error: ").append(error);
        }
        statusView.setText(status.toString());
    }

    private LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}

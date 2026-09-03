package com.lggram.tailnetrelay;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

public final class SocksRelayService extends Service {
    static final String ACTION_START = "com.lggram.tailnetrelay.action.START";
    static final String ACTION_STOP = "com.lggram.tailnetrelay.action.STOP";

    private static final String TAG = "TailnetRelay";
    private static final String CHANNEL_ID = "tailnet_relay";
    private static final int NOTIFICATION_ID = 1;
    private static final int CONNECT_TIMEOUT_MS = 10_000;
    private static final long HEALTH_CHECK_MS = 15_000;

    private static final AtomicBoolean RUNNING = new AtomicBoolean(false);
    private static final AtomicBoolean SOCKS_STARTING = new AtomicBoolean(false);
    private static final AtomicBoolean SOCKS_LISTENING = new AtomicBoolean(false);
    private static final AtomicInteger SOCKS_RESTART_FAILURES = new AtomicInteger(0);
    private static final AtomicInteger WEB_LISTENERS = new AtomicInteger(0);
    private static final AtomicBoolean RDP_LISTENING = new AtomicBoolean(false);
    private static final AtomicInteger ACTIVE_CONNECTIONS = new AtomicInteger(0);
    private static final AtomicLong TOTAL_CONNECTIONS = new AtomicLong(0);
    private static volatile String lastError = "";

    private final ExecutorService acceptExecutor = Executors.newFixedThreadPool(4);
    private final ExecutorService connectionExecutor = Executors.newCachedThreadPool();
    private final Handler healthHandler = new Handler(Looper.getMainLooper());
    private final Runnable healthCheck = this::runHealthCheck;
    private final ReverseProxyServer windowsWebBridge = createWebBridge(RelayTarget.WINDOWS);
    private final ReverseProxyServer macbookWebBridge = createWebBridge(RelayTarget.MACBOOK);
    private final ReverseProxyServer[] webBridges = { windowsWebBridge, macbookWebBridge };
    private final FixedTcpForwardServer rdpBridge = createRdpBridge();
    private volatile ServerSocket socksServerSocket;
    private volatile boolean explicitStop;

    private ReverseProxyServer createWebBridge(RelayTarget target) {
        return new ReverseProxyServer(
                acceptExecutor,
                connectionExecutor,
                target,
                new ReverseProxyServer.Events() {
                @Override
                public void onListening() {
                    WEB_LISTENERS.incrementAndGet();
                    Log.i(TAG, "Web bridge listening on " + BridgePolicy.LISTEN_HOST + ":"
                            + target.bridgePort + " for " + target.domain);
                    refreshNotification();
                }

                @Override
                public void onStopped() {
                    WEB_LISTENERS.updateAndGet(count -> Math.max(0, count - 1));
                    refreshNotification();
                }

                @Override
                public void onConnectionOpened() {
                    connectionOpened();
                }

                @Override
                public void onConnectionClosed() {
                    connectionClosed();
                }

                @Override
                public void onError(String context, IOException error) {
                    recordError(target.displayName + " " + context, error);
                }
            });
    }

    private FixedTcpForwardServer createRdpBridge() {
        return new FixedTcpForwardServer(
                acceptExecutor,
                connectionExecutor,
                RdpBridgePolicy.LISTEN_HOST,
                RdpBridgePolicy.LISTEN_PORT,
                RdpBridgePolicy.UPSTREAM_HOST,
                RdpBridgePolicy.UPSTREAM_PORT,
                RdpBridgePolicy.CONNECT_TIMEOUT_MS,
                new FixedTcpForwardServer.Events() {
                    @Override
                    public void onListening() {
                        RDP_LISTENING.set(true);
                        Log.i(TAG, "RDP bridge listening on " + RdpBridgePolicy.LISTEN_HOST
                                + ":" + RdpBridgePolicy.LISTEN_PORT + " for "
                                + RdpBridgePolicy.UPSTREAM_HOST + ":"
                                + RdpBridgePolicy.UPSTREAM_PORT);
                        refreshNotification();
                    }

                    @Override
                    public void onStopped() {
                        // An older listener can finish after a replacement has started.
                        RDP_LISTENING.set(rdpBridge.isRunning());
                        refreshNotification();
                    }

                    @Override
                    public void onConnectionOpened() {
                        connectionOpened();
                    }

                    @Override
                    public void onConnectionClosed() {
                        connectionClosed();
                    }

                    @Override
                    public void onError(String context, IOException error) {
                        recordError("RDP " + context, error);
                    }
                });
    }

    static boolean isRunning() {
        return RUNNING.get()
                && SOCKS_LISTENING.get()
                && WEB_LISTENERS.get() == RelayTarget.ALL.size()
                && RDP_LISTENING.get();
    }

    static int activeConnections() {
        return ACTIVE_CONNECTIONS.get();
    }

    static long totalConnections() {
        return TOTAL_CONNECTIONS.get();
    }

    static String lastError() {
        return lastError;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            explicitStop = true;
            RelayRestartScheduler.cancel(this);
            stopRelay();
            stopSelf();
            return START_NOT_STICKY;
        }

        explicitStop = false;
        createNotificationChannel();
        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        startRelayIfNeeded();
        RelayRestartScheduler.scheduleRegular(this);
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        boolean shouldRecover = !explicitStop && RUNNING.get();
        stopRelay();
        acceptExecutor.shutdownNow();
        connectionExecutor.shutdownNow();
        if (shouldRecover) RelayRestartScheduler.scheduleAfterTaskRemoved(this);
        super.onDestroy();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        if (!explicitStop && RUNNING.get()) {
            RelayRestartScheduler.scheduleAfterTaskRemoved(this);
        }
        super.onTaskRemoved(rootIntent);
    }

    private void startRelayIfNeeded() {
        if (RUNNING.compareAndSet(false, true)) {
            lastError = "";
        }
        startSocksListenerIfNeeded();
        for (ReverseProxyServer webBridge : webBridges) webBridge.start();
        rdpBridge.start();
        scheduleHealthCheck();
    }

    private void runHealthCheck() {
        if (!RUNNING.get()) return;
        startSocksListenerIfNeeded();
        for (ReverseProxyServer webBridge : webBridges) webBridge.start();
        rdpBridge.start();
        healthHandler.postDelayed(healthCheck, HEALTH_CHECK_MS);
    }

    private void scheduleHealthCheck() {
        healthHandler.removeCallbacks(healthCheck);
        if (RUNNING.get()) healthHandler.postDelayed(healthCheck, HEALTH_CHECK_MS);
    }

    private void startSocksListenerIfNeeded() {
        if (!RUNNING.get()
                || SOCKS_LISTENING.get()
                || !SOCKS_STARTING.compareAndSet(false, true)) {
            return;
        }
        try {
            acceptExecutor.execute(() -> {
                ServerSocket listener = null;
                try {
                    listener = new ServerSocket();
                    listener.setReuseAddress(true);
                    listener.bind(new InetSocketAddress(
                            InetAddress.getByName(RelayPolicy.LISTEN_HOST),
                            RelayPolicy.LISTEN_PORT));
                    socksServerSocket = listener;
                    SOCKS_LISTENING.set(true);
                    SOCKS_RESTART_FAILURES.set(0);
                    Log.i(TAG, "Listening on " + RelayPolicy.LISTEN_HOST + ":"
                            + RelayPolicy.LISTEN_PORT);
                    refreshNotification();
                    while (RUNNING.get()) {
                        Socket client = listener.accept();
                        client.setTcpNoDelay(true);
                        connectionExecutor.execute(() -> handleClient(client));
                    }
                } catch (IOException error) {
                    if (RUNNING.get()) {
                        recordError("SOCKS listener failed", error);
                    }
                } finally {
                    SOCKS_LISTENING.set(false);
                    SOCKS_STARTING.set(false);
                    clearSocksServerSocket(listener);
                    if (RUNNING.get()) {
                        int failures = SOCKS_RESTART_FAILURES.incrementAndGet();
                        long retryMs = RelayRetryPolicy.listenerRetryDelayMs(failures);
                        healthHandler.postDelayed(this::startSocksListenerIfNeeded, retryMs);
                        refreshNotification();
                    }
                }
            });
        } catch (RuntimeException error) {
            // A health callback can race Service.onDestroy() after its RUNNING
            // check but before the executor is shut down. Never let that
            // rejected submission crash the main thread or pin STARTING=true.
            SOCKS_STARTING.set(false);
            Log.w(TAG, "SOCKS listener restart was rejected", error);
            if (RUNNING.get()) {
                int failures = SOCKS_RESTART_FAILURES.incrementAndGet();
                healthHandler.postDelayed(
                        this::startSocksListenerIfNeeded,
                        RelayRetryPolicy.listenerRetryDelayMs(failures));
            }
        }
    }

    private void handleClient(Socket client) {
        boolean successReplySent = false;
        try (Socket localClient = client) {
            SocksProtocol.Request request = SocksProtocol.negotiate(
                    localClient.getInputStream(),
                    localClient.getOutputStream());
            RelayTarget target = RelayPolicy.targetFor(request.host, request.port);
            if (target == null) {
                SocksProtocol.writeReply(
                        localClient.getOutputStream(),
                        SocksProtocol.REPLY_NOT_ALLOWED);
                Log.w(TAG, "Rejected SOCKS target " + request.host + ":" + request.port);
                return;
            }

            try (Socket tailnet = new Socket()) {
                tailnet.setTcpNoDelay(true);
                tailnet.connect(new InetSocketAddress(
                        target.domain,
                        target.targetPort), CONNECT_TIMEOUT_MS);
                SocksProtocol.writeReply(
                        localClient.getOutputStream(),
                        SocksProtocol.REPLY_SUCCEEDED);
                successReplySent = true;
                connectionOpened();

                relayBidirectionally(localClient, tailnet);
            } finally {
                if (successReplySent) {
                    connectionClosed();
                }
            }
        } catch (IOException error) {
            if (!successReplySent) {
                try {
                    SocksProtocol.writeReply(
                            client.getOutputStream(),
                            SocksProtocol.REPLY_NETWORK_UNREACHABLE);
                } catch (IOException ignored) {
                    // The client may already have disconnected.
                }
            }
            recordError("SOCKS connection failed", error);
        }
    }

    private void connectionOpened() {
        lastError = "";
        ACTIVE_CONNECTIONS.incrementAndGet();
        TOTAL_CONNECTIONS.incrementAndGet();
        refreshNotification();
    }

    private void connectionClosed() {
        ACTIVE_CONNECTIONS.decrementAndGet();
        refreshNotification();
    }

    private void recordError(String context, IOException error) {
        lastError = error.getClass().getSimpleName() + ": " + error.getMessage();
        Log.w(TAG, context, error);
        if (RUNNING.get()) refreshNotification();
    }

    private void relayBidirectionally(Socket client, Socket tailnet) throws IOException {
        InputStream clientInput = client.getInputStream();
        OutputStream clientOutput = client.getOutputStream();
        InputStream tailnetInput = tailnet.getInputStream();
        OutputStream tailnetOutput = tailnet.getOutputStream();

        connectionExecutor.execute(() -> {
            try {
                copy(clientInput, tailnetOutput);
                tailnet.shutdownOutput();
            } catch (IOException ignored) {
                closeSocket(tailnet);
                closeSocket(client);
            }
        });

        try {
            copy(tailnetInput, clientOutput);
            try {
                client.shutdownOutput();
            } catch (IOException ignored) {
                // The peer may have already closed after receiving the response.
            }
        } finally {
            closeSocket(tailnet);
            closeSocket(client);
        }
    }

    private static void copy(InputStream input, OutputStream output) throws IOException {
        byte[] buffer = new byte[16 * 1024];
        int count;
        while ((count = input.read(buffer)) != -1) {
            output.write(buffer, 0, count);
            output.flush();
        }
    }

    private void stopRelay() {
        RUNNING.set(false);
        healthHandler.removeCallbacksAndMessages(null);
        SOCKS_STARTING.set(false);
        SOCKS_LISTENING.set(false);
        SOCKS_RESTART_FAILURES.set(0);
        WEB_LISTENERS.set(0);
        RDP_LISTENING.set(false);
        for (ReverseProxyServer webBridge : webBridges) webBridge.stop();
        rdpBridge.stop();
        closeSocksServerSocket();
        stopForeground(true);
    }

    private void closeSocksServerSocket() {
        ServerSocket listener = socksServerSocket;
        socksServerSocket = null;
        if (listener != null) {
            try {
                listener.close();
            } catch (IOException ignored) {
                // Already closed.
            }
        }
    }

    private void clearSocksServerSocket(ServerSocket listener) {
        if (socksServerSocket == listener) socksServerSocket = null;
        if (listener != null) {
            try {
                listener.close();
            } catch (IOException ignored) {
                // Already closed.
            }
        }
    }

    private static void closeSocket(Socket socket) {
        try {
            socket.close();
        } catch (IOException ignored) {
            // Already closed.
        }
    }

    private void createNotificationChannel() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                getString(R.string.notification_channel_name),
                NotificationManager.IMPORTANCE_LOW);
        channel.setDescription(
                "Local SOCKS, Agent WebUI, and RDP bridges through the work-profile tailnet");
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        Intent activityIntent = new Intent(this, RelayActivity.class);
        PendingIntent activityPendingIntent = PendingIntent.getActivity(
                this,
                0,
                activityIntent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        String status;
        if (!isRunning()) {
            status = "Starting SOCKS " + RelayPolicy.LISTEN_PORT
                    + " + Web " + BridgePolicy.LISTEN_PORT
                    + "/" + BridgePolicy.MACBOOK_LISTEN_PORT
                    + " + RDP " + RdpBridgePolicy.LISTEN_PORT;
        } else {
            status = "Web " + BridgePolicy.LISTEN_PORT + "/"
                    + BridgePolicy.MACBOOK_LISTEN_PORT
                    + " · RDP " + RdpBridgePolicy.LISTEN_PORT + " · "
                    + ACTIVE_CONNECTIONS.get() + " active · "
                    + TOTAL_CONNECTIONS.get() + " total";
        }
        return new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_relay)
                .setContentTitle(getString(R.string.notification_title))
                .setContentText(status)
                .setContentIntent(activityPendingIntent)
                .setOngoing(true)
                .setCategory(Notification.CATEGORY_SERVICE)
                .build();
    }

    private void refreshNotification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.notify(NOTIFICATION_ID, buildNotification());
    }
}

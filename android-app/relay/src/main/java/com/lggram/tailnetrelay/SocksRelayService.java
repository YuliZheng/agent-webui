package com.lggram.tailnetrelay;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.IBinder;
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

    private static final AtomicBoolean RUNNING = new AtomicBoolean(false);
    private static final AtomicBoolean SOCKS_LISTENING = new AtomicBoolean(false);
    private static final AtomicBoolean WEB_LISTENING = new AtomicBoolean(false);
    private static final AtomicInteger ACTIVE_CONNECTIONS = new AtomicInteger(0);
    private static final AtomicLong TOTAL_CONNECTIONS = new AtomicLong(0);
    private static volatile String lastError = "";

    private final ExecutorService acceptExecutor = Executors.newFixedThreadPool(2);
    private final ExecutorService connectionExecutor = Executors.newCachedThreadPool();
    private final ReverseProxyServer webBridge = new ReverseProxyServer(
            acceptExecutor,
            connectionExecutor,
            new ReverseProxyServer.Events() {
                @Override
                public void onListening() {
                    WEB_LISTENING.set(true);
                    Log.i(TAG, "Web bridge listening on " + BridgePolicy.LISTEN_HOST + ":"
                            + BridgePolicy.LISTEN_PORT);
                    refreshNotification();
                }

                @Override
                public void onStopped() {
                    WEB_LISTENING.set(false);
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
                    recordError(context, error);
                }
            });
    private volatile ServerSocket socksServerSocket;

    static boolean isRunning() {
        return RUNNING.get() && SOCKS_LISTENING.get() && WEB_LISTENING.get();
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
            stopRelay();
            stopSelf();
            return START_NOT_STICKY;
        }

        createNotificationChannel();
        startForeground(NOTIFICATION_ID, buildNotification());
        startRelayIfNeeded();
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        stopRelay();
        acceptExecutor.shutdownNow();
        connectionExecutor.shutdownNow();
        super.onDestroy();
    }

    private void startRelayIfNeeded() {
        if (RUNNING.compareAndSet(false, true)) {
            lastError = "";
            startSocksListener();
        }
        webBridge.start();
    }

    private void startSocksListener() {
        acceptExecutor.execute(() -> {
            try {
                ServerSocket listener = new ServerSocket();
                listener.setReuseAddress(true);
                listener.bind(new InetSocketAddress(
                        InetAddress.getByName(RelayPolicy.LISTEN_HOST),
                        RelayPolicy.LISTEN_PORT));
                socksServerSocket = listener;
                SOCKS_LISTENING.set(true);
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
                closeSocksServerSocket();
                refreshNotification();
            }
        });
    }

    private void handleClient(Socket client) {
        boolean successReplySent = false;
        try (Socket localClient = client) {
            SocksProtocol.Request request = SocksProtocol.negotiate(
                    localClient.getInputStream(),
                    localClient.getOutputStream());
            if (!RelayPolicy.isAllowed(request.host, request.port)) {
                SocksProtocol.writeReply(
                        localClient.getOutputStream(),
                        SocksProtocol.REPLY_NOT_ALLOWED);
                Log.w(TAG, "Rejected SOCKS target " + request.host + ":" + request.port);
                return;
            }

            try (Socket tailnet = new Socket()) {
                tailnet.setTcpNoDelay(true);
                tailnet.connect(new InetSocketAddress(
                        RelayPolicy.TARGET_TAILNET_IP,
                        RelayPolicy.TARGET_PORT), CONNECT_TIMEOUT_MS);
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
        refreshNotification();
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
        SOCKS_LISTENING.set(false);
        WEB_LISTENING.set(false);
        webBridge.stop();
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
                "Local SOCKS and Agent WebUI bridge through the work-profile tailnet");
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        Intent activityIntent = new Intent(this, RelayActivity.class);
        PendingIntent activityPendingIntent = PendingIntent.getActivity(
                this,
                0,
                activityIntent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Intent stopIntent = new Intent(this, SocksRelayService.class)
                .setAction(ACTION_STOP);
        PendingIntent stopPendingIntent = PendingIntent.getService(
                this,
                1,
                stopIntent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        String status;
        if (!isRunning()) {
            status = "Starting SOCKS " + RelayPolicy.LISTEN_PORT
                    + " + Web " + BridgePolicy.LISTEN_PORT;
        } else {
            status = "Web " + BridgePolicy.LISTEN_PORT + " · "
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
                .addAction(
                        new Notification.Action.Builder(
                                null,
                                getString(R.string.notification_stop),
                                stopPendingIntent)
                                .build())
                .build();
    }

    private void refreshNotification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.notify(NOTIFICATION_ID, buildNotification());
    }
}

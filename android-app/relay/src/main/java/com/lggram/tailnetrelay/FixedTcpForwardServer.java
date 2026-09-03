package com.lggram.tailnetrelay;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.atomic.AtomicReference;

/** A restartable, loopback-only fixed-destination TCP forwarder. */
final class FixedTcpForwardServer {
    interface Events {
        void onListening();

        void onStopped();

        void onConnectionOpened();

        void onConnectionClosed();

        void onError(String context, IOException error);
    }

    private final ExecutorService acceptExecutor;
    private final ExecutorService connectionExecutor;
    private final String listenHost;
    private final int listenPort;
    private final String targetHost;
    private final int targetPort;
    private final int connectTimeoutMs;
    private final Events events;
    private final Object stateLock = new Object();
    private final Set<Socket> activeSockets = new HashSet<>();

    private long generation;
    private boolean running;
    private boolean listening;
    private int boundPort = -1;
    private ServerSocket serverSocket;

    FixedTcpForwardServer(
            ExecutorService acceptExecutor,
            ExecutorService connectionExecutor,
            String listenHost,
            int listenPort,
            String targetHost,
            int targetPort,
            int connectTimeoutMs,
            Events events) {
        this.acceptExecutor = acceptExecutor;
        this.connectionExecutor = connectionExecutor;
        this.listenHost = listenHost;
        this.listenPort = listenPort;
        this.targetHost = targetHost;
        this.targetPort = targetPort;
        this.connectTimeoutMs = connectTimeoutMs;
        this.events = events;
    }

    void start() {
        final long runGeneration;
        synchronized (stateLock) {
            if (running) return;
            running = true;
            listening = false;
            boundPort = -1;
            runGeneration = ++generation;
        }

        try {
            acceptExecutor.execute(() -> runListener(runGeneration));
        } catch (RuntimeException error) {
            boolean reportError = false;
            synchronized (stateLock) {
                if (generation == runGeneration && running) {
                    running = false;
                    listening = false;
                    boundPort = -1;
                    reportError = true;
                }
            }
            if (reportError) {
                events.onError(
                        "TCP forward listener start was rejected",
                        rejectedExecution(error));
            }
        }
    }

    void stop() {
        ServerSocket listener;
        ArrayList<Socket> sockets;
        synchronized (stateLock) {
            if (!running && serverSocket == null && activeSockets.isEmpty()) return;
            running = false;
            listening = false;
            boundPort = -1;
            generation++;
            listener = serverSocket;
            serverSocket = null;
            sockets = new ArrayList<>(activeSockets);
            activeSockets.clear();
        }

        closeServerSocket(listener);
        for (Socket socket : sockets) closeSocket(socket);
    }

    boolean isRunning() {
        synchronized (stateLock) {
            return running && listening;
        }
    }

    int boundPort() {
        synchronized (stateLock) {
            return boundPort;
        }
    }

    private void runListener(long runGeneration) {
        ServerSocket listener = null;
        boolean announcedListening = false;
        try {
            listener = new ServerSocket();
            listener.setReuseAddress(true);
            listener.bind(new InetSocketAddress(
                    InetAddress.getByName(listenHost),
                    listenPort));

            synchronized (stateLock) {
                if (!isCurrentRunLocked(runGeneration)) return;
                serverSocket = listener;
                boundPort = listener.getLocalPort();
                listening = true;
                announcedListening = true;
                events.onListening();
            }

            while (isCurrentRun(runGeneration)) {
                Socket client = listener.accept();
                client.setTcpNoDelay(true);
                if (!trackSocket(client, runGeneration)) {
                    closeSocket(client);
                    continue;
                }
                try {
                    connectionExecutor.execute(
                            () -> handleConnection(client, runGeneration));
                } catch (RuntimeException error) {
                    untrackAndClose(client);
                    reportErrorIfCurrent(
                            runGeneration,
                            "TCP forward connection task was rejected",
                            rejectedExecution(error));
                }
            }
        } catch (IOException error) {
            reportErrorIfCurrent(
                    runGeneration,
                    "TCP forward listener failed",
                    error);
        } finally {
            closeServerSocket(listener);
            synchronized (stateLock) {
                if (serverSocket == listener) {
                    serverSocket = null;
                    listening = false;
                    boundPort = -1;
                }
                if (generation == runGeneration) running = false;
            }
            if (announcedListening) events.onStopped();
        }
    }

    private void handleConnection(Socket client, long runGeneration) {
        Socket upstream = new Socket();
        boolean opened = false;
        try {
            if (!trackSocket(upstream, runGeneration)) return;
            upstream.setTcpNoDelay(true);
            upstream.connect(
                    new InetSocketAddress(targetHost, targetPort),
                    connectTimeoutMs);

            synchronized (stateLock) {
                if (!isCurrentRunLocked(runGeneration)) return;
                opened = true;
                events.onConnectionOpened();
            }

            relayBidirectionally(client, upstream);
        } catch (IOException error) {
            reportErrorIfCurrent(
                    runGeneration,
                    "TCP forward connection failed",
                    error);
        } finally {
            untrackAndClose(upstream);
            untrackAndClose(client);
            if (opened) events.onConnectionClosed();
        }
    }

    private void relayBidirectionally(Socket client, Socket upstream) throws IOException {
        CountDownLatch clientToUpstreamDone = new CountDownLatch(1);
        AtomicReference<IOException> clientToUpstreamError = new AtomicReference<>();
        try {
            connectionExecutor.execute(() -> {
                try {
                    copy(client.getInputStream(), upstream.getOutputStream());
                    upstream.shutdownOutput();
                } catch (IOException error) {
                    clientToUpstreamError.compareAndSet(null, error);
                    closeSocket(upstream);
                    closeSocket(client);
                } finally {
                    clientToUpstreamDone.countDown();
                }
            });
        } catch (RuntimeException error) {
            throw rejectedExecution(error);
        }

        IOException upstreamToClientError = null;
        try {
            copy(upstream.getInputStream(), client.getOutputStream());
            client.shutdownOutput();
        } catch (IOException error) {
            upstreamToClientError = error;
            closeSocket(upstream);
            closeSocket(client);
        }

        try {
            clientToUpstreamDone.await();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IOException("TCP forward connection interrupted", error);
        }
        if (upstreamToClientError != null) throw upstreamToClientError;
        IOException uploadError = clientToUpstreamError.get();
        if (uploadError != null) throw uploadError;
    }

    private boolean trackSocket(Socket socket, long runGeneration) {
        synchronized (stateLock) {
            if (!isCurrentRunLocked(runGeneration)) return false;
            activeSockets.add(socket);
            return true;
        }
    }

    private void untrackAndClose(Socket socket) {
        synchronized (stateLock) {
            activeSockets.remove(socket);
        }
        closeSocket(socket);
    }

    private boolean isCurrentRun(long runGeneration) {
        synchronized (stateLock) {
            return isCurrentRunLocked(runGeneration);
        }
    }

    private boolean isCurrentRunLocked(long runGeneration) {
        return running && generation == runGeneration;
    }

    private void reportErrorIfCurrent(
            long runGeneration,
            String context,
            IOException error) {
        synchronized (stateLock) {
            if (isCurrentRunLocked(runGeneration)) events.onError(context, error);
        }
    }

    private static IOException rejectedExecution(RuntimeException error) {
        return new IOException("Executor rejected TCP forward work", error);
    }

    private static void copy(InputStream input, OutputStream output) throws IOException {
        byte[] buffer = new byte[16 * 1024];
        int count;
        while ((count = input.read(buffer)) != -1) {
            output.write(buffer, 0, count);
            output.flush();
        }
    }

    private static void closeServerSocket(ServerSocket listener) {
        if (listener == null) return;
        try {
            listener.close();
        } catch (IOException ignored) {
            // Already closed.
        }
    }

    private static void closeSocket(Socket socket) {
        if (socket == null) return;
        try {
            socket.close();
        } catch (IOException ignored) {
            // Already closed.
        }
    }
}

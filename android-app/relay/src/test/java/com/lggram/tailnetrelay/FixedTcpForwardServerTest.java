package com.lggram.tailnetrelay;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.Test;

public final class FixedTcpForwardServerTest {
    private static final long AWAIT_TIMEOUT_MS = 5_000;

    @Test
    public void forwardsHalfClosedConnectionAndRestartsWithExactEvents() throws Exception {
        InetAddress loopback = InetAddress.getByName("127.0.0.1");
        ExecutorService accepts = Executors.newSingleThreadExecutor();
        ExecutorService connections = Executors.newCachedThreadPool();
        ExecutorService upstreams = Executors.newSingleThreadExecutor();
        RecordingEvents events = new RecordingEvents();

        try (ServerSocket target = new ServerSocket(0, 1, loopback)) {
            Future<?> upstream = upstreams.submit(() -> {
                try (Socket socket = target.accept()) {
                    assertEquals("ping", new String(
                            readAll(socket.getInputStream()),
                            StandardCharsets.UTF_8));
                    socket.getOutputStream().write(
                            "pong".getBytes(StandardCharsets.UTF_8));
                    socket.shutdownOutput();
                }
                return null;
            });
            FixedTcpForwardServer server = createServer(
                    accepts,
                    connections,
                    target.getLocalPort(),
                    events);

            server.start();
            server.start();
            awaitCount(events.listening, 1);
            assertTrue(server.isRunning());

            try (Socket client = new Socket(loopback, server.boundPort())) {
                client.getOutputStream().write("ping".getBytes(StandardCharsets.UTF_8));
                client.shutdownOutput();
                assertEquals("pong", new String(
                        readAll(client.getInputStream()),
                        StandardCharsets.UTF_8));
            }
            upstream.get(5, TimeUnit.SECONDS);
            awaitCount(events.closed, 1);

            server.stop();
            server.stop();
            awaitCount(events.stopped, 1);
            assertFalse(server.isRunning());

            server.start();
            server.start();
            awaitCount(events.listening, 2);
            assertTrue(server.isRunning());
            server.stop();
            awaitCount(events.stopped, 2);

            assertEquals(2, events.listening.get());
            assertEquals(2, events.stopped.get());
            assertEquals(1, events.opened.get());
            assertEquals(1, events.closed.get());
            assertEquals(0, events.errors.get());
        } finally {
            accepts.shutdownNow();
            connections.shutdownNow();
            upstreams.shutdownNow();
        }
    }

    @Test
    public void stopClosesAnActiveClientAndUpstream() throws Exception {
        InetAddress loopback = InetAddress.getByName("127.0.0.1");
        ExecutorService accepts = Executors.newSingleThreadExecutor();
        ExecutorService connections = Executors.newCachedThreadPool();
        ExecutorService upstreams = Executors.newSingleThreadExecutor();
        RecordingEvents events = new RecordingEvents();

        try (ServerSocket target = new ServerSocket(0, 1, loopback)) {
            Future<Integer> upstreamRead = upstreams.submit(() -> {
                try (Socket socket = target.accept()) {
                    return socket.getInputStream().read();
                }
            });
            FixedTcpForwardServer server = createServer(
                    accepts,
                    connections,
                    target.getLocalPort(),
                    events);
            server.start();
            awaitCount(events.listening, 1);

            try (Socket client = new Socket(loopback, server.boundPort())) {
                client.setSoTimeout(5_000);
                awaitCount(events.opened, 1);
                server.stop();
                assertPeerClosed(client);
            }

            assertEquals(-1, (int) upstreamRead.get(5, TimeUnit.SECONDS));
            awaitCount(events.closed, 1);
            awaitCount(events.stopped, 1);
            assertEquals(1, events.opened.get());
            assertEquals(1, events.closed.get());
        } finally {
            accepts.shutdownNow();
            connections.shutdownNow();
            upstreams.shutdownNow();
        }
    }

    @Test
    public void rejectedListenerTaskResetsStateWithoutThrowing() throws Exception {
        ExecutorService accepts = Executors.newSingleThreadExecutor();
        ExecutorService connections = Executors.newCachedThreadPool();
        accepts.shutdownNow();
        RecordingEvents events = new RecordingEvents();
        FixedTcpForwardServer server = createServer(accepts, connections, 9, events);

        try {
            server.start();
            awaitCount(events.errors, 1);
            assertFalse(server.isRunning());
            assertEquals(-1, server.boundPort());
            assertEquals(0, events.listening.get());
            assertEquals(0, events.stopped.get());
        } finally {
            connections.shutdownNow();
        }
    }

    @Test
    public void rejectedConnectionTaskClosesClientWithoutConnectionEvents() throws Exception {
        InetAddress loopback = InetAddress.getByName("127.0.0.1");
        ExecutorService accepts = Executors.newSingleThreadExecutor();
        ExecutorService connections = Executors.newSingleThreadExecutor();
        connections.shutdownNow();
        RecordingEvents events = new RecordingEvents();
        FixedTcpForwardServer server = createServer(accepts, connections, 9, events);

        try {
            server.start();
            awaitCount(events.listening, 1);
            try (Socket client = new Socket(loopback, server.boundPort())) {
                client.setSoTimeout(5_000);
                assertPeerClosed(client);
            }
            awaitCount(events.errors, 1);
            assertEquals(0, events.opened.get());
            assertEquals(0, events.closed.get());
            server.stop();
            awaitCount(events.stopped, 1);
        } finally {
            accepts.shutdownNow();
        }
    }

    private static FixedTcpForwardServer createServer(
            ExecutorService accepts,
            ExecutorService connections,
            int targetPort,
            RecordingEvents events) {
        return new FixedTcpForwardServer(
                accepts,
                connections,
                "127.0.0.1",
                0,
                "127.0.0.1",
                targetPort,
                2_000,
                events);
    }

    private static void assertPeerClosed(Socket socket) throws IOException {
        try {
            assertEquals(-1, socket.getInputStream().read());
        } catch (SocketTimeoutException error) {
            throw new AssertionError("Peer socket remained open", error);
        } catch (IOException expected) {
            // A reset is also a successful forced disconnect.
        }
    }

    private static byte[] readAll(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[1_024];
        int count;
        while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
        return output.toByteArray();
    }

    private static void awaitCount(AtomicInteger value, int expected) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(AWAIT_TIMEOUT_MS);
        while (value.get() < expected && System.nanoTime() < deadline) {
            Thread.sleep(10);
        }
        assertEquals(expected, value.get());
    }

    private static final class RecordingEvents implements FixedTcpForwardServer.Events {
        final AtomicInteger listening = new AtomicInteger();
        final AtomicInteger stopped = new AtomicInteger();
        final AtomicInteger opened = new AtomicInteger();
        final AtomicInteger closed = new AtomicInteger();
        final AtomicInteger errors = new AtomicInteger();

        @Override
        public void onListening() {
            listening.incrementAndGet();
        }

        @Override
        public void onStopped() {
            stopped.incrementAndGet();
        }

        @Override
        public void onConnectionOpened() {
            opened.incrementAndGet();
        }

        @Override
        public void onConnectionClosed() {
            closed.incrementAndGet();
        }

        @Override
        public void onError(String context, IOException error) {
            errors.incrementAndGet();
        }
    }
}

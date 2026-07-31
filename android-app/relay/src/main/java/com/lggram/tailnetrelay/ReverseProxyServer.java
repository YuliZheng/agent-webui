package com.lggram.tailnetrelay;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.atomic.AtomicBoolean;

import javax.net.ssl.SNIHostName;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

final class ReverseProxyServer {
    interface Events {
        void onListening();

        void onStopped();

        void onConnectionOpened();

        void onConnectionClosed();

        void onError(String context, IOException error);
    }

    private static final int CONNECT_TIMEOUT_MS = 10_000;
    private final ExecutorService acceptExecutor;
    private final ExecutorService connectionExecutor;
    private final Events events;
    private final RelayTarget target;
    private final String localOrigin;
    private final String upstreamOrigin;
    private final AtomicBoolean running = new AtomicBoolean(false);
    private volatile ServerSocket serverSocket;

    ReverseProxyServer(
            ExecutorService acceptExecutor,
            ExecutorService connectionExecutor,
            RelayTarget target,
            Events events) {
        this.acceptExecutor = acceptExecutor;
        this.connectionExecutor = connectionExecutor;
        this.target = target;
        this.events = events;
        this.localOrigin = target.launchOrigin();
        this.upstreamOrigin = "https://" + target.domain;
    }

    void start() {
        if (!running.compareAndSet(false, true)) {
            return;
        }
        acceptExecutor.execute(() -> {
            try {
                ServerSocket listener = new ServerSocket();
                listener.setReuseAddress(true);
                listener.bind(new InetSocketAddress(
                        InetAddress.getByName(BridgePolicy.LISTEN_HOST),
                        target.bridgePort));
                serverSocket = listener;
                events.onListening();
                while (running.get()) {
                    Socket client = listener.accept();
                    client.setTcpNoDelay(true);
                    connectionExecutor.execute(() -> handleClient(client));
                }
            } catch (IOException error) {
                if (running.get()) {
                    events.onError("Web bridge listener failed", error);
                }
            } finally {
                running.set(false);
                closeServerSocket();
                events.onStopped();
            }
        });
    }

    void stop() {
        running.set(false);
        closeServerSocket();
    }

    private void handleClient(Socket client) {
        AtomicBoolean responseStarted = new AtomicBoolean(false);
        try (Socket localClient = client) {
            localClient.setSoTimeout(CONNECT_TIMEOUT_MS);
            HttpProxyProtocol.Request request =
                    HttpProxyProtocol.readRequest(localClient.getInputStream());

            if ((request.isMethod("GET") || request.isMethod("HEAD"))
                    && BridgePolicy.isPacRequestTarget(request.target)) {
                writePacResponse(localClient.getOutputStream(), request.isMethod("HEAD"));
                return;
            }
            if (request.isMethod("GET")
                    && BridgePolicy.isHealthRequestTarget(request.target)) {
                writeTextResponse(
                        localClient.getOutputStream(),
                        "200 OK",
                        "application/json; charset=utf-8",
                        "{\"status\":\"running\",\"mode\":\"work-profile-reverse-proxy\"}\n");
                return;
            }
            if (request.isMethod("CONNECT")) {
                handleConnect(localClient, request);
                return;
            }

            reverseProxy(localClient, request, responseStarted);
        } catch (IOException error) {
            if (!responseStarted.get()) {
                try {
                    writeTextResponse(
                            client.getOutputStream(),
                            "502 Bad Gateway",
                            "text/plain; charset=utf-8",
                            "Agent bridge could not reach the work-profile tailnet.\n");
                } catch (IOException ignored) {
                    // The client may already have disconnected.
                }
            }
            if (!isBenignDisconnect(error)) {
                events.onError("Web bridge connection failed", error);
            }
        }
    }

    private void reverseProxy(
            Socket localClient,
            HttpProxyProtocol.Request request,
            AtomicBoolean responseStarted) throws IOException {
        boolean counted = false;
        try (Socket upstream = openTlsUpstream()) {
            String rewrittenRequest = HttpProxyProtocol.rewriteRequestForUpstream(
                    request,
                    localOrigin,
                    upstreamOrigin,
                    target.domain);
            upstream.getOutputStream().write(
                    rewrittenRequest.getBytes(StandardCharsets.ISO_8859_1));
            upstream.getOutputStream().flush();

            upstream.setSoTimeout(0);
            localClient.setSoTimeout(0);
            counted = true;
            events.onConnectionOpened();

            InputStream clientInput = localClient.getInputStream();
            OutputStream upstreamOutput = upstream.getOutputStream();
            connectionExecutor.execute(() -> {
                try {
                    copy(clientInput, upstreamOutput);
                    upstream.shutdownOutput();
                } catch (IOException ignored) {
                    closeSocket(upstream);
                    closeSocket(localClient);
                }
            });

            InputStream upstreamInput = upstream.getInputStream();
            OutputStream clientOutput = localClient.getOutputStream();
            while (true) {
                String responseHeader = HttpProxyProtocol.readHeaderBlock(upstreamInput);
                String rewrittenResponse = HttpProxyProtocol.rewriteResponseForLocal(
                        responseHeader,
                        localOrigin,
                        upstreamOrigin,
                        target.domain);
                clientOutput.write(rewrittenResponse.getBytes(StandardCharsets.ISO_8859_1));
                clientOutput.flush();
                responseStarted.set(true);
                int status = responseStatus(responseHeader);
                if (status < 100 || status >= 200 || status == 101) {
                    copy(upstreamInput, clientOutput);
                    return;
                }
            }
        } finally {
            if (counted) {
                events.onConnectionClosed();
            }
        }
    }

    private void handleConnect(
            Socket localClient,
            HttpProxyProtocol.Request request) throws IOException {
        HttpProxyProtocol.Authority authority =
                HttpProxyProtocol.parseConnectAuthority(request.target);
        RelayTarget connectTarget = RelayPolicy.targetFor(authority.host, authority.port);
        if (connectTarget == null) {
            writeTextResponse(
                    localClient.getOutputStream(),
                    "403 Forbidden",
                    "text/plain; charset=utf-8",
                    "This bridge only accepts Agent WebUI.\n");
            return;
        }

        boolean counted = false;
        try (Socket tailnet = openTailnetSocket(connectTarget)) {
            tailnet.setSoTimeout(0);
            localClient.setSoTimeout(0);
            localClient.getOutputStream().write((
                    "HTTP/1.1 200 Connection Established\r\n"
                            + "Proxy-Agent: AgentBridge/1.5\r\n"
                            + "\r\n").getBytes(StandardCharsets.ISO_8859_1));
            localClient.getOutputStream().flush();
            counted = true;
            events.onConnectionOpened();
            relayBidirectionally(localClient, tailnet);
        } finally {
            if (counted) {
                events.onConnectionClosed();
            }
        }
    }

    private Socket openTailnetSocket(RelayTarget upstreamTarget) throws IOException {
        Socket tailnet = new Socket();
        try {
            tailnet.setTcpNoDelay(true);
            tailnet.connect(
                    new InetSocketAddress(
                            upstreamTarget.domain,
                            upstreamTarget.targetPort),
                    CONNECT_TIMEOUT_MS);
            tailnet.setSoTimeout(CONNECT_TIMEOUT_MS);
            return tailnet;
        } catch (IOException error) {
            closeSocket(tailnet);
            throw error;
        }
    }

    private Socket openTlsUpstream() throws IOException {
        Socket tailnet = openTailnetSocket(target);
        try {
            SSLSocketFactory factory = (SSLSocketFactory) SSLSocketFactory.getDefault();
            SSLSocket tls = (SSLSocket) factory.createSocket(
                    tailnet,
                    target.domain,
                    target.targetPort,
                    true);
            SSLParameters parameters = tls.getSSLParameters();
            parameters.setEndpointIdentificationAlgorithm("HTTPS");
            parameters.setServerNames(Collections.singletonList(
                    new SNIHostName(target.domain)));
            tls.setSSLParameters(parameters);
            tls.setUseClientMode(true);
            tls.setSoTimeout(CONNECT_TIMEOUT_MS);
            tls.startHandshake();
            return tls;
        } catch (IOException | RuntimeException error) {
            closeSocket(tailnet);
            if (error instanceof IOException) {
                throw (IOException) error;
            }
            throw new IOException("Could not configure upstream TLS", error);
        }
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

    private void writePacResponse(OutputStream output, boolean headersOnly) throws IOException {
        String body = headersOnly ? "" : BridgePolicy.proxyAutoConfig();
        writeResponse(
                output,
                "200 OK",
                "application/x-ns-proxy-autoconfig; charset=utf-8",
                body,
                headersOnly ? BridgePolicy.proxyAutoConfig()
                        .getBytes(StandardCharsets.UTF_8).length : -1);
    }

    private static void writeTextResponse(
            OutputStream output,
            String status,
            String contentType,
            String body) throws IOException {
        writeResponse(output, status, contentType, body, -1);
    }

    private static void writeResponse(
            OutputStream output,
            String status,
            String contentType,
            String body,
            int explicitContentLength) throws IOException {
        byte[] bodyBytes = body.getBytes(StandardCharsets.UTF_8);
        int contentLength = explicitContentLength >= 0
                ? explicitContentLength
                : bodyBytes.length;
        String headers = "HTTP/1.1 " + status + "\r\n"
                + "Content-Type: " + contentType + "\r\n"
                + "Content-Length: " + contentLength + "\r\n"
                + "Cache-Control: no-store\r\n"
                + "Connection: close\r\n"
                + "\r\n";
        output.write(headers.getBytes(StandardCharsets.ISO_8859_1));
        if (!body.isEmpty()) {
            output.write(bodyBytes);
        }
        output.flush();
    }

    private static int responseStatus(String responseHeader) throws IOException {
        int lineEnd = responseHeader.indexOf("\r\n");
        if (lineEnd <= 0) {
            throw new IOException("Malformed upstream HTTP response");
        }
        String[] parts = responseHeader.substring(0, lineEnd).split("\\s+", 3);
        if (parts.length < 2) {
            throw new IOException("Malformed upstream HTTP status");
        }
        try {
            return Integer.parseInt(parts[1]);
        } catch (NumberFormatException error) {
            throw new IOException("Malformed upstream HTTP status", error);
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

    private void closeServerSocket() {
        ServerSocket listener = serverSocket;
        serverSocket = null;
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

    private static boolean isBenignDisconnect(IOException error) {
        String message = error.getMessage();
        if (message == null) {
            return false;
        }
        String normalized = message.toLowerCase(Locale.ROOT);
        return normalized.contains("connection reset")
                || normalized.contains("broken pipe")
                || normalized.contains("socket closed")
                || normalized.contains("enotconn");
    }
}

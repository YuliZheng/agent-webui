package com.lggram.tailnetrelay;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

final class HttpProxyProtocol {
    private static final int MAX_HEADER_BYTES = 32 * 1024;

    static final class Request {
        final String method;
        final String target;
        final String version;
        final String rawHeader;

        Request(String method, String target, String version, String rawHeader) {
            this.method = method;
            this.target = target;
            this.version = version;
            this.rawHeader = rawHeader;
        }

        boolean isMethod(String candidate) {
            return method.equalsIgnoreCase(candidate);
        }

        boolean isWebSocketUpgrade() {
            for (Header header : parseHeaders(rawHeader)) {
                if (header.name.equalsIgnoreCase("Upgrade")
                        && header.value.equalsIgnoreCase("websocket")) {
                    return true;
                }
            }
            return false;
        }
    }

    static final class Authority {
        final String host;
        final int port;

        Authority(String host, int port) {
            this.host = host;
            this.port = port;
        }
    }

    private static final class Header {
        final String name;
        final String value;

        Header(String name, String value) {
            this.name = name;
            this.value = value;
        }
    }

    private HttpProxyProtocol() {
    }

    static Request readRequest(InputStream input) throws IOException {
        String raw = readHeaderBlock(input);
        int lineEnd = raw.indexOf("\r\n");
        if (lineEnd <= 0) {
            throw new IOException("Malformed HTTP request");
        }
        String[] parts = raw.substring(0, lineEnd).trim().split("\\s+");
        if (parts.length != 3) {
            throw new IOException("Malformed HTTP request line");
        }
        if (!parts[2].toUpperCase(Locale.ROOT).startsWith("HTTP/")) {
            throw new IOException("Unsupported HTTP protocol");
        }
        return new Request(parts[0], parts[1], parts[2], raw);
    }

    static String readHeaderBlock(InputStream input) throws IOException {
        ByteArrayOutputStream header = new ByteArrayOutputStream();
        int matched = 0;
        while (header.size() < MAX_HEADER_BYTES) {
            int value = input.read();
            if (value == -1) {
                throw new IOException("Connection closed before HTTP headers");
            }
            header.write(value);
            if ((matched == 0 || matched == 2) && value == '\r') {
                matched += 1;
            } else if ((matched == 1 || matched == 3) && value == '\n') {
                matched += 1;
            } else {
                matched = value == '\r' ? 1 : 0;
            }
            if (matched == 4) {
                return header.toString(StandardCharsets.ISO_8859_1.name());
            }
        }
        throw new IOException("HTTP header is too large");
    }

    static String rewriteRequestForUpstream(
            Request request,
            String localOrigin,
            String upstreamOrigin,
            String upstreamHost) throws IOException {
        String target = upstreamRequestTarget(request.target, localOrigin);
        List<Header> headers = parseHeaders(request.rawHeader);
        boolean websocket = request.isWebSocketUpgrade();
        boolean wroteHost = false;
        boolean wroteConnection = false;
        StringBuilder rewritten = new StringBuilder()
                .append(request.method).append(' ')
                .append(target).append(' ')
                .append(request.version).append("\r\n");

        for (Header header : headers) {
            if (header.name.equalsIgnoreCase("Host")) {
                rewritten.append("Host: ").append(upstreamHost).append("\r\n");
                wroteHost = true;
            } else if (header.name.equalsIgnoreCase("Origin")) {
                rewritten.append(header.name).append(": ")
                        .append(rewriteLocalUrl(
                                header.value,
                                localOrigin,
                                upstreamOrigin))
                        .append("\r\n");
            } else if (header.name.equalsIgnoreCase("Referer")) {
                rewritten.append(header.name).append(": ")
                        .append(rewriteLocalUrl(
                                header.value,
                                localOrigin,
                                upstreamOrigin))
                        .append("\r\n");
            } else if (header.name.equalsIgnoreCase("Proxy-Connection")) {
                // A reverse-proxy hop must not forward proxy-only connection state.
            } else if (header.name.equalsIgnoreCase("Connection")) {
                if (websocket) {
                    rewritten.append(header.name).append(": ")
                            .append(header.value).append("\r\n");
                } else {
                    rewritten.append("Connection: close\r\n");
                }
                wroteConnection = true;
            } else {
                rewritten.append(header.name).append(": ")
                        .append(header.value).append("\r\n");
            }
        }
        if (!wroteHost) {
            rewritten.append("Host: ").append(upstreamHost).append("\r\n");
        }
        if (!wroteConnection) {
            rewritten.append(websocket ? "Connection: Upgrade\r\n" : "Connection: close\r\n");
        }
        rewritten.append("\r\n");
        return rewritten.toString();
    }

    static String rewriteResponseForLocal(
            String rawHeader,
            String localOrigin,
            String upstreamOrigin,
            String upstreamHost) throws IOException {
        int lineEnd = rawHeader.indexOf("\r\n");
        if (lineEnd <= 0 || !rawHeader.substring(0, lineEnd)
                .toUpperCase(Locale.ROOT).startsWith("HTTP/")) {
            throw new IOException("Malformed upstream HTTP response");
        }

        StringBuilder rewritten = new StringBuilder(
                rawHeader.substring(0, lineEnd)).append("\r\n");
        for (Header header : parseHeaders(rawHeader)) {
            if (header.name.equalsIgnoreCase("Location")
                    || header.name.equalsIgnoreCase("Content-Location")) {
                rewritten.append(header.name).append(": ")
                        .append(rewriteUpstreamUrl(
                                header.value,
                                upstreamOrigin,
                                localOrigin))
                        .append("\r\n");
            } else if (header.name.equalsIgnoreCase("Access-Control-Allow-Origin")
                    && header.value.equalsIgnoreCase(upstreamOrigin)) {
                rewritten.append(header.name).append(": ")
                        .append(localOrigin).append("\r\n");
            } else if (header.name.equalsIgnoreCase("Set-Cookie")) {
                rewritten.append(header.name).append(": ")
                        .append(removeUpstreamCookieDomain(header.value, upstreamHost))
                        .append("\r\n");
            } else if (!header.name.equalsIgnoreCase("Strict-Transport-Security")) {
                rewritten.append(header.name).append(": ")
                        .append(header.value).append("\r\n");
            }
        }
        rewritten.append("\r\n");
        return rewritten.toString();
    }

    private static String upstreamRequestTarget(String target, String localOrigin)
            throws IOException {
        if (target == null || target.isEmpty()) {
            throw new IOException("Missing HTTP request target");
        }
        if (target.startsWith("/")) {
            return target;
        }
        if ("*".equals(target)) {
            return target;
        }

        try {
            URI uri = new URI(target);
            if (!"http".equalsIgnoreCase(uri.getScheme())
                    || uri.getRawUserInfo() != null
                    || uri.getHost() == null
                    || !isLocalBridgeAuthority(uri, localOrigin)) {
                throw new IOException("The local bridge only accepts its own origin");
            }
            String path = uri.getRawPath();
            if (path == null || path.isEmpty()) {
                path = "/";
            }
            if (uri.getRawQuery() != null) {
                path += "?" + uri.getRawQuery();
            }
            return path;
        } catch (URISyntaxException error) {
            throw new IOException("Malformed HTTP request target", error);
        }
    }

    private static boolean isLocalBridgeAuthority(URI uri, String localOrigin)
            throws URISyntaxException {
        URI expected = new URI(localOrigin);
        int actualPort = uri.getPort() == -1 ? 80 : uri.getPort();
        int expectedPort = expected.getPort() == -1 ? 80 : expected.getPort();
        String host = uri.getHost();
        return actualPort == expectedPort
                && (host.equalsIgnoreCase(expected.getHost())
                || host.equalsIgnoreCase("localhost"));
    }

    private static String rewriteLocalUrl(
            String value,
            String localOrigin,
            String upstreamOrigin) {
        if (startsWithIgnoreCase(value, localOrigin)) {
            return upstreamOrigin + value.substring(localOrigin.length());
        }
        String localhostOrigin = "http://localhost:" + BridgePolicy.LISTEN_PORT;
        if (startsWithIgnoreCase(value, localhostOrigin)) {
            return upstreamOrigin + value.substring(localhostOrigin.length());
        }
        return value;
    }

    private static String rewriteUpstreamUrl(
            String value,
            String upstreamOrigin,
            String localOrigin) {
        if (startsWithIgnoreCase(value, upstreamOrigin)) {
            return localOrigin + value.substring(upstreamOrigin.length());
        }
        return value;
    }

    private static String removeUpstreamCookieDomain(String value, String upstreamHost) {
        String[] attributes = value.split(";", -1);
        StringBuilder rewritten = new StringBuilder(attributes[0].trim());
        for (int index = 1; index < attributes.length; index += 1) {
            String attribute = attributes[index].trim();
            if (attribute.toLowerCase(Locale.ROOT).startsWith("domain=")) {
                String domain = attribute.substring("domain=".length()).trim();
                if (domain.startsWith(".")) {
                    domain = domain.substring(1);
                }
                if (domain.equalsIgnoreCase(upstreamHost)) {
                    continue;
                }
            }
            if (!attribute.isEmpty()) {
                rewritten.append("; ").append(attribute);
            }
        }
        return rewritten.toString();
    }

    private static boolean startsWithIgnoreCase(String value, String prefix) {
        return value.regionMatches(true, 0, prefix, 0, prefix.length());
    }

    private static List<Header> parseHeaders(String rawHeader) {
        List<Header> headers = new ArrayList<>();
        int firstLineEnd = rawHeader.indexOf("\r\n");
        if (firstLineEnd < 0) {
            return headers;
        }
        int cursor = firstLineEnd + 2;
        while (cursor < rawHeader.length()) {
            int lineEnd = rawHeader.indexOf("\r\n", cursor);
            if (lineEnd < 0 || lineEnd == cursor) {
                break;
            }
            String line = rawHeader.substring(cursor, lineEnd);
            int separator = line.indexOf(':');
            if (separator > 0) {
                headers.add(new Header(
                        line.substring(0, separator).trim(),
                        line.substring(separator + 1).trim()));
            }
            cursor = lineEnd + 2;
        }
        return headers;
    }

    static Authority parseConnectAuthority(String rawAuthority) throws IOException {
        if (rawAuthority == null) {
            throw new IOException("Missing CONNECT authority");
        }
        String authority = rawAuthority.trim();
        String host;
        String portText;
        if (authority.startsWith("[")) {
            int closeBracket = authority.indexOf(']');
            if (closeBracket <= 1
                    || closeBracket + 2 >= authority.length()
                    || authority.charAt(closeBracket + 1) != ':') {
                throw new IOException("Malformed IPv6 CONNECT authority");
            }
            host = authority.substring(1, closeBracket);
            portText = authority.substring(closeBracket + 2);
        } else {
            int separator = authority.lastIndexOf(':');
            if (separator <= 0 || separator == authority.length() - 1) {
                throw new IOException("CONNECT target must include a port");
            }
            host = authority.substring(0, separator);
            portText = authority.substring(separator + 1);
        }

        int port;
        try {
            port = Integer.parseInt(portText);
        } catch (NumberFormatException error) {
            throw new IOException("CONNECT port is invalid", error);
        }
        if (port < 1 || port > 65535) {
            throw new IOException("CONNECT port is out of range");
        }
        return new Authority(host, port);
    }
}

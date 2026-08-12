package com.lggram.tailnetrelay;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

import org.junit.Test;

public final class HttpProxyProtocolTest {
    @Test
    public void parsesHttpsConnectWithoutReadingTunnelBytes() throws Exception {
        String raw = "CONNECT " + RelayPolicy.ALLOWED_DOMAIN + ":443 HTTP/1.1\r\n"
                + "Host: " + RelayPolicy.ALLOWED_DOMAIN + ":443\r\n"
                + "\r\n"
                + "TLS";
        ByteArrayInputStream input =
                new ByteArrayInputStream(raw.getBytes(StandardCharsets.ISO_8859_1));

        HttpProxyProtocol.Request request = HttpProxyProtocol.readRequest(input);
        HttpProxyProtocol.Authority authority =
                HttpProxyProtocol.parseConnectAuthority(request.target);

        assertTrue(request.isMethod("CONNECT"));
        assertEquals(RelayPolicy.ALLOWED_DOMAIN, authority.host);
        assertEquals(443, authority.port);
        assertEquals('T', input.read());
    }

    @Test
    public void parsesPacRetrieval() throws Exception {
        String raw = "GET /proxy.pac HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";

        HttpProxyProtocol.Request request = HttpProxyProtocol.readRequest(
                new ByteArrayInputStream(raw.getBytes(StandardCharsets.ISO_8859_1)));

        assertTrue(request.isMethod("GET"));
        assertEquals("/proxy.pac", request.target);
        assertEquals("HTTP/1.1", request.version);
        assertEquals(raw, request.rawHeader);
    }

    @Test
    public void rewritesLocalHttpRequestForFixedHttpsUpstream() throws Exception {
        String localOrigin = "http://127.0.0.1:38484";
        String upstreamOrigin = "https://" + RelayPolicy.ALLOWED_DOMAIN;
        String raw = "POST /api/login?next=%2F HTTP/1.1\r\n"
                + "Host: 127.0.0.1:38484\r\n"
                + "Origin: " + localOrigin + "\r\n"
                + "Referer: " + localOrigin + "/login\r\n"
                + "Proxy-Connection: keep-alive\r\n"
                + "Connection: keep-alive\r\n"
                + "Content-Length: 4\r\n\r\nBODY";
        ByteArrayInputStream input =
                new ByteArrayInputStream(raw.getBytes(StandardCharsets.ISO_8859_1));

        HttpProxyProtocol.Request request = HttpProxyProtocol.readRequest(input);
        String rewritten = HttpProxyProtocol.rewriteRequestForUpstream(
                request,
                localOrigin,
                upstreamOrigin,
                RelayPolicy.ALLOWED_DOMAIN);

        assertTrue(rewritten.startsWith("POST /api/login?next=%2F HTTP/1.1\r\n"));
        assertTrue(rewritten.contains(
                "\r\nHost: " + RelayPolicy.ALLOWED_DOMAIN + "\r\n"));
        assertTrue(rewritten.contains("\r\nOrigin: " + upstreamOrigin + "\r\n"));
        assertTrue(rewritten.contains(
                "\r\nReferer: " + upstreamOrigin + "/login\r\n"));
        assertTrue(rewritten.contains("\r\nConnection: close\r\n"));
        assertFalse(rewritten.toLowerCase().contains("proxy-connection"));
        assertEquals('B', input.read());
    }

    @Test
    public void preservesWebSocketUpgradeAndRewritesOrigin() throws Exception {
        String localOrigin = "http://127.0.0.1:38484";
        String upstreamOrigin = "https://" + RelayPolicy.ALLOWED_DOMAIN;
        String raw = "GET /api/ws HTTP/1.1\r\n"
                + "Host: 127.0.0.1:38484\r\n"
                + "Origin: " + localOrigin + "\r\n"
                + "Connection: keep-alive, Upgrade\r\n"
                + "Upgrade: websocket\r\n\r\n";
        HttpProxyProtocol.Request request = HttpProxyProtocol.readRequest(
                new ByteArrayInputStream(raw.getBytes(StandardCharsets.ISO_8859_1)));

        String rewritten = HttpProxyProtocol.rewriteRequestForUpstream(
                request,
                localOrigin,
                upstreamOrigin,
                RelayPolicy.ALLOWED_DOMAIN);

        assertTrue(request.isWebSocketUpgrade());
        assertTrue(rewritten.contains("\r\nConnection: keep-alive, Upgrade\r\n"));
        assertTrue(rewritten.contains("\r\nUpgrade: websocket\r\n"));
        assertTrue(rewritten.contains("\r\nOrigin: " + upstreamOrigin + "\r\n"));
    }

    @Test
    public void rewritesAbsoluteLocalRequestTargetAndRejectsOtherOrigins() throws Exception {
        String localOrigin = "http://127.0.0.1:38484";
        String upstreamOrigin = "https://" + RelayPolicy.ALLOWED_DOMAIN;
        String raw = "GET " + localOrigin + "/assets/app.js?v=1 HTTP/1.1\r\n"
                + "Host: 127.0.0.1:38484\r\n\r\n";
        HttpProxyProtocol.Request request = HttpProxyProtocol.readRequest(
                new ByteArrayInputStream(raw.getBytes(StandardCharsets.ISO_8859_1)));

        String rewritten = HttpProxyProtocol.rewriteRequestForUpstream(
                request,
                localOrigin,
                upstreamOrigin,
                RelayPolicy.ALLOWED_DOMAIN);

        assertTrue(rewritten.startsWith("GET /assets/app.js?v=1 HTTP/1.1\r\n"));

        String foreign = "GET http://example.com/ HTTP/1.1\r\n"
                + "Host: example.com\r\n\r\n";
        HttpProxyProtocol.Request foreignRequest = HttpProxyProtocol.readRequest(
                new ByteArrayInputStream(foreign.getBytes(StandardCharsets.ISO_8859_1)));
        assertThrows(
                IOException.class,
                () -> HttpProxyProtocol.rewriteRequestForUpstream(
                        foreignRequest,
                        localOrigin,
                        upstreamOrigin,
                        RelayPolicy.ALLOWED_DOMAIN));
    }

    @Test
    public void rewritesRedirectCorsAndCookieDomainForLocalOrigin() throws Exception {
        String localOrigin = "http://127.0.0.1:38484";
        String upstreamOrigin = "https://" + RelayPolicy.ALLOWED_DOMAIN;
        String raw = "HTTP/1.1 302 Found\r\n"
                + "Location: " + upstreamOrigin + "/login\r\n"
                + "Access-Control-Allow-Origin: " + upstreamOrigin + "\r\n"
                + "Set-Cookie: sid=abc; Domain=." + RelayPolicy.ALLOWED_DOMAIN
                + "; Path=/; Secure; HttpOnly\r\n"
                + "Strict-Transport-Security: max-age=31536000\r\n"
                + "Content-Length: 0\r\n\r\n";

        String rewritten = HttpProxyProtocol.rewriteResponseForLocal(
                raw,
                localOrigin,
                upstreamOrigin,
                RelayPolicy.ALLOWED_DOMAIN);

        assertTrue(rewritten.contains("\r\nLocation: " + localOrigin + "/login\r\n"));
        assertTrue(rewritten.contains(
                "\r\nAccess-Control-Allow-Origin: " + localOrigin + "\r\n"));
        assertTrue(rewritten.contains(
                "\r\nSet-Cookie: sid=abc; Path=/; Secure; HttpOnly\r\n"));
        assertFalse(rewritten.toLowerCase().contains("strict-transport-security"));
        assertFalse(rewritten.toLowerCase().contains("domain="));
    }

    @Test
    public void preservesTheRequestedLoopbackAliasAsTheLocalOrigin() throws Exception {
        HttpProxyProtocol.Request localhost = HttpProxyProtocol.readRequest(
                new ByteArrayInputStream(("GET / HTTP/1.1\r\n"
                        + "Host: localhost:38485\r\n\r\n")
                        .getBytes(StandardCharsets.ISO_8859_1)));
        HttpProxyProtocol.Request ipv4 = HttpProxyProtocol.readRequest(
                new ByteArrayInputStream(("GET / HTTP/1.1\r\n"
                        + "Host: 127.0.0.1:38485\r\n\r\n")
                        .getBytes(StandardCharsets.ISO_8859_1)));

        assertEquals(
                "http://localhost:38485",
                HttpProxyProtocol.localLoopbackOrigin(localhost, 38485));
        assertEquals(
                "http://127.0.0.1:38485",
                HttpProxyProtocol.localLoopbackOrigin(ipv4, 38485));
    }

    @Test
    public void rejectsForeignOrWrongPortBridgeHosts() throws Exception {
        HttpProxyProtocol.Request foreign = HttpProxyProtocol.readRequest(
                new ByteArrayInputStream(("GET / HTTP/1.1\r\n"
                        + "Host: example.com:38485\r\n\r\n")
                        .getBytes(StandardCharsets.ISO_8859_1)));
        HttpProxyProtocol.Request wrongPort = HttpProxyProtocol.readRequest(
                new ByteArrayInputStream(("GET / HTTP/1.1\r\n"
                        + "Host: localhost:38484\r\n\r\n")
                        .getBytes(StandardCharsets.ISO_8859_1)));

        assertThrows(
                IOException.class,
                () -> HttpProxyProtocol.localLoopbackOrigin(foreign, 38485));
        assertThrows(
                IOException.class,
                () -> HttpProxyProtocol.localLoopbackOrigin(wrongPort, 38485));
    }

    @Test
    public void parsesBracketedIpv6Authority() throws Exception {
        HttpProxyProtocol.Authority authority =
                HttpProxyProtocol.parseConnectAuthority("[fd7a:115c:a1e0::1]:443");

        assertEquals("fd7a:115c:a1e0::1", authority.host);
        assertEquals(443, authority.port);
    }

    @Test
    public void rejectsMissingOrInvalidPorts() {
        assertThrows(
                IOException.class,
                () -> HttpProxyProtocol.parseConnectAuthority("example.com"));
        assertThrows(
                IOException.class,
                () -> HttpProxyProtocol.parseConnectAuthority("example.com:70000"));
        assertThrows(
                IOException.class,
                () -> HttpProxyProtocol.parseConnectAuthority("example.com:https"));
    }
}

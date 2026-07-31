package com.lggram.tailnetrelay;

import java.util.Locale;

final class RelayPolicy {
    static final String LISTEN_HOST = "127.0.0.1";
    static final int LISTEN_PORT = 38483;

    static final String ALLOWED_DOMAIN = "lggram.tail6c8b6c.ts.net";
    static final String TARGET_TAILNET_IP = "100.98.215.97";
    static final int TARGET_PORT = 443;

    private RelayPolicy() {
    }

    static boolean isAllowed(String requestedHost, int requestedPort) {
        if (requestedHost == null || requestedPort != TARGET_PORT) {
            return false;
        }
        String normalized = requestedHost.trim().toLowerCase(Locale.ROOT);
        while (normalized.endsWith(".")) {
            normalized = normalized.substring(0, normalized.length() - 1);
        }
        return ALLOWED_DOMAIN.equals(normalized) || TARGET_TAILNET_IP.equals(normalized);
    }
}

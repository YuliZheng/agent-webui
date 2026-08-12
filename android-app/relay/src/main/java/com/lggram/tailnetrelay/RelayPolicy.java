package com.lggram.tailnetrelay;

import java.util.Locale;

final class RelayPolicy {
    static final String LISTEN_HOST = "127.0.0.1";
    static final int LISTEN_PORT = 38483;

    // Compatibility aliases for the original Windows target.
    static final String ALLOWED_DOMAIN = RelayTarget.WINDOWS.domain;
    static final String TARGET_TAILNET_IP = RelayTarget.WINDOWS.tailnetIp;
    static final int TARGET_PORT = RelayTarget.WINDOWS.targetPort;

    private RelayPolicy() {
    }

    static boolean isAllowed(String requestedHost, int requestedPort) {
        return targetFor(requestedHost, requestedPort) != null;
    }

    static RelayTarget targetFor(String requestedHost, int requestedPort) {
        if (requestedHost == null) return null;
        String normalized = requestedHost.trim().toLowerCase(Locale.ROOT);
        while (normalized.endsWith(".")) {
            normalized = normalized.substring(0, normalized.length() - 1);
        }
        for (RelayTarget target : RelayTarget.ALL) {
            if (requestedPort == target.targetPort
                    && (target.domain.equals(normalized) || target.tailnetIp.equals(normalized))) {
                return target;
            }
        }
        return null;
    }
}

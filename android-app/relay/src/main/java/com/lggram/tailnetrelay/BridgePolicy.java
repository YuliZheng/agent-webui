package com.lggram.tailnetrelay;

import java.util.Locale;

final class BridgePolicy {
    static final String LISTEN_HOST = "127.0.0.1";
    static final int LISTEN_PORT = 38484;
    static final String PAC_PATH = "/proxy.pac";
    static final String HEALTH_PATH = "/health";
    static final String PAC_URL = "http://" + LISTEN_HOST + ":" + LISTEN_PORT + PAC_PATH;

    private BridgePolicy() {
    }

    static boolean isPacRequestTarget(String target) {
        if (target == null) {
            return false;
        }
        String normalized = target.trim();
        if (PAC_PATH.equals(normalized)) {
            return true;
        }
        return normalized.equals(PAC_URL);
    }

    static boolean isHealthRequestTarget(String target) {
        if (target == null) {
            return false;
        }
        String normalized = target.trim();
        return HEALTH_PATH.equals(normalized)
                || normalized.equals("http://" + LISTEN_HOST + ":" + LISTEN_PORT
                + HEALTH_PATH);
    }

    static boolean isAllowedConnectTarget(String host, int port) {
        return RelayPolicy.isAllowed(host, port);
    }

    static String proxyAutoConfig() {
        String domain = RelayPolicy.ALLOWED_DOMAIN.toLowerCase(Locale.ROOT);
        String ip = RelayPolicy.TARGET_TAILNET_IP;
        return "function FindProxyForURL(url, host) {\n"
                + "  var target = host.toLowerCase();\n"
                + "  if (target === \"" + domain + "\" || target === \"" + ip + "\") {\n"
                + "    return \"PROXY " + LISTEN_HOST + ":" + LISTEN_PORT + "\";\n"
                + "  }\n"
                + "  return \"DIRECT\";\n"
                + "}\n";
    }
}

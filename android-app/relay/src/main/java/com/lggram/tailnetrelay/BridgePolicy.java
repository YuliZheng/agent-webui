package com.lggram.tailnetrelay;

import java.util.Locale;

final class BridgePolicy {
    static final String LISTEN_HOST = "127.0.0.1";
    static final int LISTEN_PORT = RelayTarget.WINDOWS.bridgePort;
    static final int MACBOOK_LISTEN_PORT = RelayTarget.MACBOOK.bridgePort;
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
        StringBuilder condition = new StringBuilder();
        for (RelayTarget target : RelayTarget.ALL) {
            if (condition.length() > 0) condition.append(" || ");
            condition.append("target === \"")
                    .append(target.domain.toLowerCase(Locale.ROOT))
                    .append("\" || target === \"")
                    .append(target.tailnetIp)
                    .append("\"");
        }
        return "function FindProxyForURL(url, host) {\n"
                + "  var target = host.toLowerCase();\n"
                + "  if (" + condition + ") {\n"
                + "    return \"PROXY " + LISTEN_HOST + ":" + LISTEN_PORT + "\";\n"
                + "  }\n"
                + "  return \"DIRECT\";\n"
                + "}\n";
    }
}

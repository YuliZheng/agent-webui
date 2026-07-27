package com.lggram.agentwebui;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

final class NavigationPolicy {
    private static final URI TRUSTED_URI = URI.create(BuildConfig.WEB_APP_URL);
    private static final String TRUSTED_HOST =
            TRUSTED_URI.getHost().toLowerCase(Locale.ROOT);
    private static final int TRUSTED_PORT = effectivePort(TRUSTED_URI);

    private NavigationPolicy() {}

    static boolean isTrustedAppUrl(String candidate) {
        if (candidate == null || candidate.isBlank()) return false;

        final URI uri;
        try {
            uri = new URI(candidate);
        } catch (URISyntaxException | IllegalArgumentException ignored) {
            return false;
        }

        if (!"https".equalsIgnoreCase(uri.getScheme())) return false;
        if (uri.getUserInfo() != null) return false;
        if (uri.getHost() == null) return false;
        if (!TRUSTED_HOST.equals(uri.getHost().toLowerCase(Locale.ROOT))) return false;
        return effectivePort(uri) == TRUSTED_PORT;
    }

    static boolean canOpenExternally(String candidate) {
        if (candidate == null || candidate.isBlank()) return false;
        final URI uri;
        try {
            uri = new URI(candidate);
        } catch (URISyntaxException | IllegalArgumentException ignored) {
            return false;
        }
        if (uri.getScheme() == null) return false;
        switch (uri.getScheme().toLowerCase(Locale.ROOT)) {
            case "https":
            case "http":
            case "mailto":
            case "tel":
                return true;
            default:
                return false;
        }
    }

    private static int effectivePort(URI uri) {
        if (uri.getPort() >= 0) return uri.getPort();
        return "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
    }
}

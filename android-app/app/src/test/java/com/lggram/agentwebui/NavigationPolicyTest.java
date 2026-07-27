package com.lggram.agentwebui;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class NavigationPolicyTest {
    @Test
    public void trustedOriginAllowsNormalAppRoutes() {
        assertTrue(NavigationPolicy.isTrustedAppUrl("https://lggram.tail6c8b6c.ts.net/"));
        assertTrue(NavigationPolicy.isTrustedAppUrl(
                "https://LGGRAM.tail6c8b6c.ts.net/api/sessions?id=one#latest"
        ));
        assertTrue(NavigationPolicy.isTrustedAppUrl(
                "https://lggram.tail6c8b6c.ts.net:443/manifest.webmanifest"
        ));
    }

    @Test
    public void trustedOriginRejectsLookalikesAndCleartext() {
        assertFalse(NavigationPolicy.isTrustedAppUrl("http://lggram.tail6c8b6c.ts.net/"));
        assertFalse(NavigationPolicy.isTrustedAppUrl("https://lggram.tail6c8b6c.ts.net:444/"));
        assertFalse(NavigationPolicy.isTrustedAppUrl("https://evil-lggram.tail6c8b6c.ts.net/"));
        assertFalse(NavigationPolicy.isTrustedAppUrl("https://lggram.tail6c8b6c.ts.net.evil.test/"));
        assertFalse(NavigationPolicy.isTrustedAppUrl(
                "https://user@lggram.tail6c8b6c.ts.net/"
        ));
        assertFalse(NavigationPolicy.isTrustedAppUrl("javascript:alert(1)"));
        assertFalse(NavigationPolicy.isTrustedAppUrl("not a url"));
        assertFalse(NavigationPolicy.isTrustedAppUrl(null));
    }

    @Test
    public void onlyKnownExternalSchemesAreDelegated() {
        assertTrue(NavigationPolicy.canOpenExternally("https://example.com"));
        assertTrue(NavigationPolicy.canOpenExternally("http://example.com"));
        assertTrue(NavigationPolicy.canOpenExternally("mailto:person@example.com"));
        assertTrue(NavigationPolicy.canOpenExternally("tel:+861234567890"));
        assertFalse(NavigationPolicy.canOpenExternally("intent://danger"));
        assertFalse(NavigationPolicy.canOpenExternally("file:///sdcard/secret"));
        assertFalse(NavigationPolicy.canOpenExternally("content://private/item"));
    }
}

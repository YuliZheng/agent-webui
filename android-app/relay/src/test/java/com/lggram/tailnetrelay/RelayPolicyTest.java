package com.lggram.tailnetrelay;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class RelayPolicyTest {
    @Test
    public void acceptsOnlyConfiguredAgentDomainsOrFixedTailnetIpsOnHttps() {
        assertTrue(RelayPolicy.isAllowed("lggram.tail6c8b6c.ts.net", 443));
        assertTrue(RelayPolicy.isAllowed("LGGRAM.TAIL6C8B6C.TS.NET.", 443));
        assertTrue(RelayPolicy.isAllowed("100.98.215.97", 443));
        assertTrue(RelayPolicy.isAllowed("leomacbook-pro.tail6c8b6c.ts.net", 443));
        assertTrue(RelayPolicy.isAllowed("100.89.50.69", 443));

        assertFalse(RelayPolicy.isAllowed("example.com", 443));
        assertFalse(RelayPolicy.isAllowed("lggram.tail6c8b6c.ts.net", 80));
        assertFalse(RelayPolicy.isAllowed("leomacbook-pro.tail6c8b6c.ts.net", 80));
        assertFalse(RelayPolicy.isAllowed(null, 443));
    }

    @Test
    public void resolvesEachAllowedHostToItsOwnTailnetTarget() {
        assertTrue(RelayPolicy.targetFor(RelayTarget.WINDOWS.domain, 443)
                == RelayTarget.WINDOWS);
        assertTrue(RelayPolicy.targetFor(RelayTarget.MACBOOK.domain, 443)
                == RelayTarget.MACBOOK);
        assertTrue(RelayPolicy.targetFor(RelayTarget.MACBOOK.tailnetIp, 443)
                == RelayTarget.MACBOOK);
        assertTrue(RelayTarget.MACBOOK.forceChrome);
        assertTrue(RelayTarget.MACBOOK.launchPath.equals("/agent-macbook-38485/"));
    }
}

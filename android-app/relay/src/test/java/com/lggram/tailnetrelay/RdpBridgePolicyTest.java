package com.lggram.tailnetrelay;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public final class RdpBridgePolicyTest {
    @Test
    public void exposesOnlyTheFixedWindowsRdpRoute() {
        assertEquals("127.0.0.1", RdpBridgePolicy.LISTEN_HOST);
        assertEquals(38_486, RdpBridgePolicy.LISTEN_PORT);
        assertEquals(RelayTarget.WINDOWS.domain, RdpBridgePolicy.UPSTREAM_HOST);
        assertEquals(3_389, RdpBridgePolicy.UPSTREAM_PORT);
    }
}

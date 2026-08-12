package com.lggram.tailnetrelay;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class BridgePolicyTest {
    @Test
    public void pacSelectsOnlyAgentAndLeavesEverythingElseDirect() {
        String pac = BridgePolicy.proxyAutoConfig();

        assertTrue(pac.contains("target === \"" + RelayPolicy.ALLOWED_DOMAIN + "\""));
        assertTrue(pac.contains("target === \"" + RelayPolicy.TARGET_TAILNET_IP + "\""));
        assertTrue(pac.contains("target === \"" + RelayTarget.MACBOOK.domain + "\""));
        assertTrue(pac.contains("target === \"" + RelayTarget.MACBOOK.tailnetIp + "\""));
        assertTrue(pac.contains(
                "PROXY " + BridgePolicy.LISTEN_HOST + ":" + BridgePolicy.LISTEN_PORT));
        assertTrue(pac.contains("return \"DIRECT\""));
        assertFalse(pac.contains("*."));
    }

    @Test
    public void recognizesOnlyLocalPacAndHealthUrls() {
        assertTrue(BridgePolicy.isPacRequestTarget("/proxy.pac"));
        assertTrue(BridgePolicy.isPacRequestTarget(BridgePolicy.PAC_URL));
        assertFalse(BridgePolicy.isPacRequestTarget("/"));
        assertFalse(BridgePolicy.isPacRequestTarget("https://example.com/proxy.pac"));

        assertTrue(BridgePolicy.isHealthRequestTarget("/health"));
        assertFalse(BridgePolicy.isHealthRequestTarget("/proxy.pac"));
    }

    @Test
    public void connectPolicyReusesTheNarrowWorkRelayAllowlist() {
        assertTrue(BridgePolicy.isAllowedConnectTarget(RelayPolicy.ALLOWED_DOMAIN, 443));
        assertTrue(BridgePolicy.isAllowedConnectTarget(RelayPolicy.TARGET_TAILNET_IP, 443));
        assertTrue(BridgePolicy.isAllowedConnectTarget(RelayTarget.MACBOOK.domain, 443));
        assertTrue(BridgePolicy.isAllowedConnectTarget(RelayTarget.MACBOOK.tailnetIp, 443));
        assertFalse(BridgePolicy.isAllowedConnectTarget("example.com", 443));
        assertFalse(BridgePolicy.isAllowedConnectTarget(RelayPolicy.ALLOWED_DOMAIN, 80));
    }
}

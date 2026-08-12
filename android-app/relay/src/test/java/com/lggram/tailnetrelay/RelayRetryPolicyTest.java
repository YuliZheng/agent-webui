package com.lggram.tailnetrelay;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public final class RelayRetryPolicyTest {
    @Test
    public void backsOffListenerRestartsWithThirtySecondCap() {
        assertEquals(1_000, RelayRetryPolicy.listenerRetryDelayMs(0));
        assertEquals(1_000, RelayRetryPolicy.listenerRetryDelayMs(1));
        assertEquals(2_000, RelayRetryPolicy.listenerRetryDelayMs(2));
        assertEquals(16_000, RelayRetryPolicy.listenerRetryDelayMs(5));
        assertEquals(30_000, RelayRetryPolicy.listenerRetryDelayMs(6));
        assertEquals(30_000, RelayRetryPolicy.listenerRetryDelayMs(100));
    }
}

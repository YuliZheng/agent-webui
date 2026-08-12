package com.lggram.tailnetrelay;

final class RelayRetryPolicy {
    private static final long MIN_LISTENER_RETRY_MS = 1_000;
    private static final long MAX_LISTENER_RETRY_MS = 30_000;

    private RelayRetryPolicy() {
    }

    static long listenerRetryDelayMs(int consecutiveFailures) {
        int exponent = Math.max(0, Math.min(5, consecutiveFailures - 1));
        return Math.min(MAX_LISTENER_RETRY_MS, MIN_LISTENER_RETRY_MS << exponent);
    }
}

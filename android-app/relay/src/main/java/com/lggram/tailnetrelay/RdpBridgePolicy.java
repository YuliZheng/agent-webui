package com.lggram.tailnetrelay;

final class RdpBridgePolicy {
    static final String LISTEN_HOST = "127.0.0.1";
    static final int LISTEN_PORT = 38_486;
    static final String UPSTREAM_HOST = RelayTarget.WINDOWS.domain;
    static final int UPSTREAM_PORT = 3_389;
    static final int CONNECT_TIMEOUT_MS = 10_000;

    private RdpBridgePolicy() {
    }
}

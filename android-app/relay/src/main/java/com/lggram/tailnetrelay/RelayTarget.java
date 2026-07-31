package com.lggram.tailnetrelay;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

final class RelayTarget {
    static final RelayTarget WINDOWS = new RelayTarget(
            "Windows Agent",
            "lggram.tail6c8b6c.ts.net",
            "100.98.215.97",
            443,
            38484,
            "/",
            false);
    static final RelayTarget MACBOOK = new RelayTarget(
            "agent-macbook",
            "leomacbook-pro.tail6c8b6c.ts.net",
            "100.89.50.69",
            443,
            38485,
            "/agent-macbook-38485/",
            true);
    static final List<RelayTarget> ALL = Collections.unmodifiableList(
            Arrays.asList(WINDOWS, MACBOOK));

    final String displayName;
    final String domain;
    final String tailnetIp;
    final int targetPort;
    final int bridgePort;
    final String launchPath;
    final boolean forceChrome;

    private RelayTarget(
            String displayName,
            String domain,
            String tailnetIp,
            int targetPort,
            int bridgePort,
            String launchPath,
            boolean forceChrome) {
        this.displayName = displayName;
        this.domain = domain;
        this.tailnetIp = tailnetIp;
        this.targetPort = targetPort;
        this.bridgePort = bridgePort;
        this.launchPath = launchPath;
        this.forceChrome = forceChrome;
    }
}

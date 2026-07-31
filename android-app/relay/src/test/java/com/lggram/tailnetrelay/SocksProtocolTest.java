package com.lggram.tailnetrelay;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

import org.junit.Test;

public final class SocksProtocolTest {
    @Test
    public void negotiatesNoAuthDomainConnect() throws Exception {
        byte[] domain = RelayPolicy.ALLOWED_DOMAIN.getBytes(StandardCharsets.US_ASCII);
        ByteArrayOutputStream request = new ByteArrayOutputStream();
        request.write(new byte[]{0x05, 0x01, 0x00});
        request.write(new byte[]{0x05, 0x01, 0x00, 0x03, (byte) domain.length});
        request.write(domain);
        request.write(new byte[]{0x01, (byte) 0xBB});

        ByteArrayOutputStream response = new ByteArrayOutputStream();
        SocksProtocol.Request parsed = SocksProtocol.negotiate(
                new ByteArrayInputStream(request.toByteArray()),
                response);

        assertEquals(RelayPolicy.ALLOWED_DOMAIN, parsed.host);
        assertEquals(443, parsed.port);
        assertArrayEquals(new byte[]{0x05, 0x00}, response.toByteArray());
    }

    @Test
    public void writesAValidIpv4Reply() throws Exception {
        ByteArrayOutputStream response = new ByteArrayOutputStream();
        SocksProtocol.writeReply(response, SocksProtocol.REPLY_NOT_ALLOWED);
        assertArrayEquals(
                new byte[]{0x05, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0},
                response.toByteArray());
    }
}

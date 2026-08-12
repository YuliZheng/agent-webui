package com.lggram.tailnetrelay;

import static org.junit.Assert.assertEquals;

import java.io.DataInputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import org.junit.Test;

public final class SocksClientTest {
    @Test
    public void establishesDomainConnectTunnel() throws Exception {
        InetAddress loopback = InetAddress.getByName("127.0.0.1");
        ExecutorService executor = Executors.newSingleThreadExecutor();
        try (ServerSocket listener = new ServerSocket(0, 1, loopback)) {
            Future<?> server = executor.submit(() -> {
                try (Socket socket = listener.accept()) {
                    DataInputStream input = new DataInputStream(socket.getInputStream());
                    OutputStream output = socket.getOutputStream();

                    assertEquals(0x05, input.readUnsignedByte());
                    assertEquals(0x01, input.readUnsignedByte());
                    assertEquals(0x00, input.readUnsignedByte());
                    output.write(new byte[]{0x05, 0x00});
                    output.flush();

                    assertEquals(0x05, input.readUnsignedByte());
                    assertEquals(0x01, input.readUnsignedByte());
                    assertEquals(0x00, input.readUnsignedByte());
                    assertEquals(0x03, input.readUnsignedByte());
                    int hostLength = input.readUnsignedByte();
                    byte[] host = new byte[hostLength];
                    input.readFully(host);
                    assertEquals(RelayPolicy.ALLOWED_DOMAIN,
                            new String(host, StandardCharsets.US_ASCII));
                    assertEquals(443, input.readUnsignedShort());

                    output.write(new byte[]{
                            0x05, 0x00, 0x00, 0x01,
                            127, 0, 0, 1,
                            0x12, 0x34,
                    });
                    output.flush();
                }
                return null;
            });

            try (Socket client = new Socket(loopback, listener.getLocalPort())) {
                SocksClient.establish(client, RelayPolicy.ALLOWED_DOMAIN, 443);
            }
            server.get(5, TimeUnit.SECONDS);
        } finally {
            executor.shutdownNow();
        }
    }
}

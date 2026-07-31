package com.lggram.tailnetrelay;

import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

final class SocksClient {
    private SocksClient() {
    }

    static void establish(Socket proxy, String host, int port) throws IOException {
        byte[] hostBytes = host.getBytes(StandardCharsets.US_ASCII);
        if (hostBytes.length == 0 || hostBytes.length > 255) {
            throw new IOException("SOCKS target host is invalid");
        }

        InputStream rawInput = proxy.getInputStream();
        OutputStream output = proxy.getOutputStream();
        DataInputStream input = new DataInputStream(rawInput);

        output.write(new byte[]{0x05, 0x01, 0x00});
        output.flush();
        if (input.readUnsignedByte() != 0x05 || input.readUnsignedByte() != 0x00) {
            throw new IOException("Work-profile SOCKS relay rejected authentication");
        }

        output.write(new byte[]{0x05, 0x01, 0x00, 0x03, (byte) hostBytes.length});
        output.write(hostBytes);
        output.write((port >>> 8) & 0xFF);
        output.write(port & 0xFF);
        output.flush();

        if (input.readUnsignedByte() != 0x05) {
            throw new IOException("Malformed SOCKS response");
        }
        int reply = input.readUnsignedByte();
        input.readUnsignedByte();
        int addressType = input.readUnsignedByte();
        skipAddress(input, addressType);
        input.readUnsignedShort();
        if (reply != SocksProtocol.REPLY_SUCCEEDED) {
            throw new IOException("Work-profile SOCKS relay failed with code " + reply);
        }
    }

    private static void skipAddress(DataInputStream input, int addressType) throws IOException {
        int length;
        if (addressType == 0x01) {
            length = 4;
        } else if (addressType == 0x03) {
            length = input.readUnsignedByte();
        } else if (addressType == 0x04) {
            length = 16;
        } else {
            throw new IOException("Unsupported SOCKS response address");
        }
        byte[] ignored = new byte[length];
        input.readFully(ignored);
    }
}

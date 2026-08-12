package com.lggram.tailnetrelay;

import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;

final class SocksProtocol {
    static final int REPLY_SUCCEEDED = 0x00;
    static final int REPLY_NOT_ALLOWED = 0x02;
    static final int REPLY_NETWORK_UNREACHABLE = 0x03;
    static final int REPLY_COMMAND_UNSUPPORTED = 0x07;
    static final int REPLY_ADDRESS_UNSUPPORTED = 0x08;

    static final class Request {
        final String host;
        final int port;

        Request(String host, int port) {
            this.host = host;
            this.port = port;
        }
    }

    private SocksProtocol() {
    }

    static Request negotiate(InputStream rawInput, OutputStream output) throws IOException {
        DataInputStream input = new DataInputStream(rawInput);
        int version = input.readUnsignedByte();
        if (version != 0x05) {
            throw new IOException("Unsupported SOCKS version");
        }

        int methodCount = input.readUnsignedByte();
        boolean supportsNoAuthentication = false;
        for (int index = 0; index < methodCount; index += 1) {
            if (input.readUnsignedByte() == 0x00) {
                supportsNoAuthentication = true;
            }
        }
        if (!supportsNoAuthentication) {
            output.write(new byte[]{0x05, (byte) 0xFF});
            output.flush();
            throw new IOException("Client requires authentication");
        }
        output.write(new byte[]{0x05, 0x00});
        output.flush();

        if (input.readUnsignedByte() != 0x05) {
            throw new IOException("Malformed SOCKS request");
        }
        int command = input.readUnsignedByte();
        input.readUnsignedByte();
        int addressType = input.readUnsignedByte();

        String host;
        if (addressType == 0x01) {
            byte[] address = new byte[4];
            input.readFully(address);
            host = InetAddress.getByAddress(address).getHostAddress();
        } else if (addressType == 0x03) {
            int length = input.readUnsignedByte();
            byte[] address = new byte[length];
            input.readFully(address);
            host = new String(address, StandardCharsets.US_ASCII);
        } else if (addressType == 0x04) {
            byte[] address = new byte[16];
            input.readFully(address);
            host = InetAddress.getByAddress(address).getHostAddress();
        } else {
            writeReply(output, REPLY_ADDRESS_UNSUPPORTED);
            throw new IOException("Unsupported SOCKS address type");
        }

        int port = input.readUnsignedShort();
        if (command != 0x01) {
            writeReply(output, REPLY_COMMAND_UNSUPPORTED);
            throw new IOException("Only SOCKS CONNECT is supported");
        }
        return new Request(host, port);
    }

    static void writeReply(OutputStream output, int reply) throws IOException {
        output.write(new byte[]{
                0x05,
                (byte) reply,
                0x00,
                0x01,
                0x00, 0x00, 0x00, 0x00,
                0x00, 0x00,
        });
        output.flush();
    }
}

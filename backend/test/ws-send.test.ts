import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  sendJson,
  WS_MAX_BUFFERED_BYTES,
  WS_SLOW_CLIENT_CLOSE_CODE,
} from "../src/services/ws-send.js";

function fakeSocket(
  readyState = WebSocket.OPEN,
  bufferedAmount = 0,
): WebSocket & { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  return {
    readyState,
    bufferedAmount,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket & {
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
}

describe("sendJson", () => {
  it("sends an ordinary JSON message", () => {
    const socket = fakeSocket();
    expect(sendJson(socket, { type: "pong", seq: 2 })).toBe(true);
    expect(socket.send).toHaveBeenCalledWith('{"type":"pong","seq":2}');
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("closes a slow client before its outbound queue can grow without bound", () => {
    const socket = fakeSocket(WebSocket.OPEN, WS_MAX_BUFFERED_BYTES + 1);
    expect(sendJson(socket, { type: "stream-line" })).toBe(false);
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledWith(
      WS_SLOW_CLIENT_CLOSE_CODE,
      "Client too slow",
    );
  });

  it("does not enqueue data on a closed socket", () => {
    const socket = fakeSocket(WebSocket.CLOSED);
    expect(sendJson(socket, { type: "pong" })).toBe(false);
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  });
});

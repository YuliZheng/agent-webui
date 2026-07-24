import { WebSocket } from "ws";

// `ws.send()` queues in userland when the browser/network cannot keep up.
// Never drop transcript lines (that would create permanent index gaps):
// close the slow connection instead so the normal reconnect path resumes from
// the browser cache's next physical line index.
export const WS_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
export const WS_MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
export const WS_SLOW_CLIENT_CLOSE_CODE = 1013;

export function sendJson(socket: WebSocket, value: unknown): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  const payload = JSON.stringify(value);
  const payloadBytes = Buffer.byteLength(payload);
  if (
    payloadBytes > WS_MAX_MESSAGE_BYTES ||
    socket.bufferedAmount > WS_MAX_BUFFERED_BYTES ||
    (socket.bufferedAmount > 0 && socket.bufferedAmount + payloadBytes > WS_MAX_BUFFERED_BYTES)
  ) {
    try { socket.close(WS_SLOW_CLIENT_CLOSE_CODE, "Client too slow"); } catch { /* already closing */ }
    return false;
  }
  socket.send(payload);
  return true;
}

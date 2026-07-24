import type { WebSocket } from "ws";
import { sendJson } from "./ws-send.js";

export interface PushEvent { type: string; [key: string]: unknown }

export class PubSub {
  private globals = new Set<WebSocket>();
  private seq = 0;
  private notifications: PushEvent[] = [];

  addGlobal(socket: WebSocket, since?: number): void {
    this.globals.add(socket);
    this.send(socket, { type: "notif-baseline", kind: "notif-baseline", seq: this.seq });
    if (typeof since === "number") for (const event of this.notifications) if (Number(event.seq) > since) this.send(socket, event);
  }
  remove(socket: WebSocket): void { this.globals.delete(socket); }
  push(event: PushEvent): void { for (const socket of this.globals) this.send(socket, event); }
  notify(event: Omit<PushEvent, "seq">): void {
    const notification = { ...event, type: "notification", kind: "notification", seq: ++this.seq };
    this.notifications.push(notification);
    if (this.notifications.length > 256) this.notifications.shift();
    this.push(notification);
  }
  send(socket: WebSocket, event: PushEvent): void {
    sendJson(socket, event);
  }
}

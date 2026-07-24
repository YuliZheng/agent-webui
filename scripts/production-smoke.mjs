import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import WebSocket from "ws";
import { buildApp } from "../backend/dist/app.js";

const token = "b".repeat(64);
const home = homedir();
const stateDir = await mkdtemp(join(tmpdir(), "agent-webui-smoke-"));
const app = await buildApp({
  home,
  stateDir,
  token,
  startWatchers: false,
  logger: false,
});

function wsClose(url, options) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    const timeout = setTimeout(() => reject(new Error("WebSocket close timeout")), 5_000);
    socket.once("close", code => { clearTimeout(timeout); resolve(code); });
    socket.once("error", error => {
      if (!String(error.message).includes("Unexpected server response")) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  });
}

function wsRpc(url, cookie) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Cookie: cookie } });
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error("WebSocket RPC timeout"));
    }, 10_000);
    socket.once("open", () => socket.send(JSON.stringify({ type: "get-sessions", reqId: "smoke-rpc" })));
    socket.on("message", data => {
      const message = JSON.parse(String(data));
      if (message.reqId !== "smoke-rpc") return;
      clearTimeout(timeout);
      socket.close();
      if (message.type !== "result" || message.ok !== true || !Array.isArray(message.data)) reject(new Error("Unexpected WebSocket RPC response"));
      else resolve(message.data);
    });
    socket.once("error", error => { clearTimeout(timeout); reject(error); });
  });
}

try {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind a TCP port");
  const base = `http://127.0.0.1:${address.port}`;
  const wsUrl = `ws://127.0.0.1:${address.port}/ws/main`;

  const unauthorized = await fetch(`${base}/api/me`);
  const bind = await fetch(`${base}/?token=${token}`, { redirect: "manual" });
  const setCookie = bind.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0];
  const spa = await fetch(`${base}/`, { headers: { Cookie: cookie } });
  const sessionsHttp = await fetch(`${base}/api/sessions`, { headers: { Cookie: cookie } }).then(response => response.json());
  const unauthWsClose = await wsClose(wsUrl);
  const sessionsWs = await wsRpc(wsUrl, cookie);
  const agents = [...new Set(sessionsWs.map(session => session.agent))].sort();

  const result = {
    unauthorized: unauthorized.status,
    bind: bind.status,
    cookie: cookie.startsWith("cw_token="),
    cookieHttpOnly: /;\s*HttpOnly(?:;|$)/i.test(setCookie),
    spa: spa.status === 200 && (await spa.text()).includes('<div id="app">'),
    httpSessionCount: Array.isArray(sessionsHttp) ? sessionsHttp.length : -1,
    websocketSessionCount: sessionsWs.length,
    agents,
    unauthWsClose,
    authWsRpc: true,
  };
  if (result.unauthorized !== 401 || result.bind !== 302 || !result.cookie || !result.cookieHttpOnly || !result.spa || result.unauthWsClose !== 1008) {
    throw new Error(`Production smoke failed: ${JSON.stringify(result)}`);
  }
  console.log(JSON.stringify(result));
} finally {
  await app.close();
  await rm(stateDir, { recursive: true, force: true });
}

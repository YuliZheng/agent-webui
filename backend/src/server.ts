import { constants as osConstants, networkInterfaces, setPriority } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { buildApp } from "./app.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined;
}
const host = arg("--host") ?? process.env.AGENT_WEBUI_HOST ?? "0.0.0.0";
const port = Number(arg("--port") ?? process.env.AGENT_WEBUI_PORT ?? 3457);
const explicitToken = arg("--token") ?? process.env.AGENT_WEBUI_TOKEN;
const codexRuntime = arg("--codex-runtime") ?? process.env.AGENT_WEBUI_CODEX_RUNTIME ?? "persistent";
// Keep the interactive server at the platform default. Archive discovery is
// paced internally; lowering the priority of the entire Node process also
// penalizes prompt, WebSocket, and HTTP handling while a cold scan is active.
// Operators may still opt into a lower priority explicitly.
const processPriority = process.env.AGENT_WEBUI_PROCESS_PRIORITY ?? "normal";
if (processPriority !== "normal") {
  const priority = processPriority === "below-normal"
    ? osConstants.priority.PRIORITY_BELOW_NORMAL
    : osConstants.priority.PRIORITY_LOW;
  try { setPriority(0, priority); } catch { /* unsupported / policy-restricted */ }
}
const app = await buildApp({
  token: explicitToken, logger: true,
  claudeBinary: arg("--claude-binary") ?? process.env.AGENT_WEBUI_CLAUDE_BINARY,
  codexBinary: arg("--codex-binary") ?? process.env.AGENT_WEBUI_CODEX_BINARY,
  persistentCodexRuntime: codexRuntime !== "stdio",
  codexRuntimeEndpoint: arg("--codex-runtime-endpoint") ?? process.env.AGENT_WEBUI_CODEX_RUNTIME_ENDPOINT,
});
await app.listen({ host, port });
const tokenPath = join(homedir(), ".agent-webui", "token");
// Resolve the file once so a missing/unreadable token still fails startup, but
// never print the bearer secret (or a URL containing it) into durable logs.
if (!explicitToken) await readFile(tokenPath, "utf8");
const interfaces = networkInterfaces();
const addresses = Object.values(interfaces).flat().filter(item => item?.family === "IPv4" && !item.internal).map(item => item!.address);
const local = host === "0.0.0.0" ? "127.0.0.1" : host;
app.log.info(`Agent WebUI: http://${local}:${port}/`);
app.log.info(explicitToken
  ? "Sign in with the configured AGENT_WEBUI_TOKEN/--token value"
  : `Sign in with the access token stored at ${tokenPath}`);
for (const address of addresses) app.log.info(`LAN: http://${address}:${port}/`);

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void app.close().finally(() => process.exit(0)));

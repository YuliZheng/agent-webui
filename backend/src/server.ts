import { constants as osConstants, networkInterfaces, setPriority } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { buildApp } from "./app.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined;
}
const host = arg("--host") ?? process.env.AGENT_WEBUI_HOST ?? "0.0.0.0";
const port = Number(arg("--port") ?? process.env.AGENT_WEBUI_PORT ?? 3456);
const explicitToken = arg("--token") ?? process.env.AGENT_WEBUI_TOKEN;
// Archive discovery is background housekeeping, not an interactive desktop
// workload. Low priority keeps a first cold scan from competing with
// the browser, editor, or agent CLI. Set AGENT_WEBUI_PROCESS_PRIORITY=normal
// only when an operator explicitly wants the platform default.
const processPriority = process.env.AGENT_WEBUI_PROCESS_PRIORITY ?? "low";
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
});
await app.listen({ host, port });
const token = explicitToken ?? (await readFile(join(homedir(), ".agent-webui", "token"), "utf8")).trim();
const interfaces = networkInterfaces();
const addresses = Object.values(interfaces).flat().filter(item => item?.family === "IPv4" && !item.internal).map(item => item!.address);
const local = host === "0.0.0.0" ? "127.0.0.1" : host;
app.log.info(`Agent WebUI: http://${local}:${port}/`);
app.log.info(`Bind this browser once: http://${local}:${port}/?token=${token}`);
for (const address of addresses) app.log.info(`LAN: http://${address}:${port}/`);

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void app.close().finally(() => process.exit(0)));

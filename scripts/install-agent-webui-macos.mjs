import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configurePwaName } from "./configure-pwa-name.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const value = flag => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const appName = value("--name") ?? "agent-macbook";
const port = Number(value("--port") ?? 3457);
const publicPort = Number(value("--public-port") ?? 38485);
if (process.platform !== "darwin") throw new Error("This installer only supports macOS");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid port");
if (!Number.isSafeInteger(publicPort) || publicPort < 1 || publicPort > 65_535) {
  throw new Error("Invalid public port");
}

const major = Number(process.versions.node.split(".")[0]);
if (major < 20) throw new Error(`Node.js 20+ is required; found ${process.version}`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

function xml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[character]);
}

run("npm", ["ci"]);
run("npm", ["run", "build"]);
const pwaPath = `/agent-macbook-${publicPort}`;
await configurePwaName({
  distDir: join(root, "frontend", "dist"),
  name: appName,
  id: pwaPath,
  startUrl: `${pwaPath}/`,
  scope: `${pwaPath}/`,
});

const home = homedir();
const stateDir = join(home, ".agent-webui");
const agentsDir = join(home, "Library", "LaunchAgents");
const label = "com.agent-webui.macbook";
const plistPath = join(agentsDir, `${label}.plist`);
const runner = join(root, "scripts", "run-agent-webui-macos.sh");
const pathValue = `/opt/homebrew/bin:/usr/local/bin:${join(home, ".local", "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`;
await mkdir(stateDir, { recursive: true });
await mkdir(agentsDir, { recursive: true });
await chmod(runner, 0o755);

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${xml(runner)}</string></array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${xml(pathValue)}</string>
    <key>AGENT_WEBUI_HOST</key><string>127.0.0.1</string>
    <key>AGENT_WEBUI_PORT</key><string>${port}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(join(stateDir, "agent-macbook.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(stateDir, "agent-macbook.error.log"))}</string>
</dict></plist>
`;
const temporaryPlist = `${plistPath}.tmp`;
await writeFile(temporaryPlist, plist, { encoding: "utf8", mode: 0o600 });
await rename(temporaryPlist, plistPath);

const domain = `gui/${process.getuid()}`;
spawnSync("launchctl", ["bootout", domain, plistPath], { stdio: "ignore" });
run("launchctl", ["bootstrap", domain, plistPath]);
run("launchctl", ["kickstart", "-k", `${domain}/${label}`]);

const deadline = Date.now() + 20_000;
let healthy = false;
while (Date.now() < deadline) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
    if (response.status > 0) { healthy = true; break; }
  } catch { /* service is still starting */ }
  await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
}
if (!healthy) throw new Error(`Agent WebUI did not start on 127.0.0.1:${port}`);

const tailscale = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
try {
  execFileSync(tailscale, ["serve", "--bg", `http://127.0.0.1:${port}`], { stdio: "inherit" });
} catch (error) {
  console.warn(`Agent WebUI is running locally, but Tailscale Serve setup failed: ${error.message}`);
  process.exitCode = 2;
}

console.log(`${appName} is running on http://127.0.0.1:${port}/`);

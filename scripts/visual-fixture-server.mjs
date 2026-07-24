import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../backend/dist/app.js";

const root = await mkdtemp(join(tmpdir(), "agent-webui-visual-"));
const claudeRoot = join(root, "claude");
const codexRoot = join(root, "codex");
const stateDir = join(root, "state");
await Promise.all([
  mkdir(claudeRoot, { recursive: true }),
  mkdir(codexRoot, { recursive: true }),
  mkdir(stateDir, { recursive: true }),
]);

const now = new Date("2026-07-23T08:30:00.000Z");
const titles = {};
const samples = [
  ["reference_main", "Optimize transcript rendering", "🤖", "C:\\workspace\\agent-webui-demo"],
  ["reconnect", "Debug WebSocket reconnect", "🔧", "C:\\workspace\\agent-webui-demo"],
  ["auth_flow", "Review token authentication flow", "🔐", "C:\\workspace\\agent-webui-demo"],
  ["tailer", "Validate JSONL tail indexes", "📜", "C:\\workspace\\agent-webui-demo"],
  ["cache", "Bound the transcript cache", "🗃️", "C:\\workspace\\agent-webui-demo"],
  ["mobile", "Polish mobile chat layout", "📱", "C:\\workspace\\agent-webui-demo"],
  ["search", "Test full-content search", "🔎", "C:\\workspace\\agent-webui-demo"],
  ["markdown", "Improve Markdown export", "📝", "C:\\workspace\\agent-webui-demo"],
  ["tasks", "Reconstruct background tasks", "⚙️", "C:\\workspace\\agent-webui-demo"],
  ["preview", "Harden preview sandbox", "🛡️", "C:\\workspace\\agent-webui-demo"],
  ["tools", "Group consecutive tool calls", "🧰", "C:\\workspace\\agent-webui-demo"],
  ["new_session", "Refine new-session workflow", "🧩", "C:\\workspace\\agent-webui-demo"],
];

function record(type, uuid, parentUuid, cwd, message, timestamp) {
  return JSON.stringify({ type, uuid, parentUuid, cwd, timestamp, message });
}

for (let index = 0; index < samples.length; index += 1) {
  const [id, title, emoji, cwd] = samples[index];
  titles[id] = { title, emoji, source: "auto" };
  const timestamp = new Date(now.getTime() - index * 12 * 60_000).toISOString();
  const lines = [
    JSON.stringify({ type: "system", subtype: "init", cwd, timestamp }),
    record("user", `${id}_u1`, null, cwd, {
      role: "user",
      content: index === 0
        ? "This long transcript becomes slow after many tool calls. Please identify the bottleneck."
        : `Please continue ${title} and check the current state first.`,
    }, timestamp),
    record("assistant", `${id}_a1`, `${id}_u1`, cwd, {
      role: "assistant",
      content: [{ type: "text", text: index === 0
        ? "The main cost is rendering every historical row at once. I will inspect the cache and render window before changing behavior."
        : `I checked the current state of ${title}. Here is the concise result.` }],
    }, new Date(Date.parse(timestamp) + 12_000).toISOString()),
  ];
  if (index === 0) {
    for (let tool = 0; tool < 3; tool += 1) {
      const toolId = `tool_${tool}`;
      lines.push(record("assistant", `reference_tool_a_${tool}`, `reference_main_a1`, cwd, {
        role: "assistant",
        content: [{ type: "tool_use", id: toolId, name: "Bash", input: { command: tool === 0 ? "git status" : tool === 1 ? "rg -n \"print\" ." : "Get-Printer" } }],
      }, new Date(Date.parse(timestamp) + 14_000 + tool * 1_000).toISOString()));
      lines.push(record("user", `reference_tool_r_${tool}`, `reference_tool_a_${tool}`, cwd, {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolId, content: `tool ${tool + 1} completed` }],
      }, new Date(Date.parse(timestamp) + 14_500 + tool * 1_000).toISOString()));
    }
    lines.push(record("assistant", "reference_main_a2", "reference_tool_r_2", cwd, {
      role: "assistant",
      content: [{ type: "text", text: [
        "I found the bottleneck. The data loader is fast, but the browser eagerly instantiates every historical message and code block.",
        "",
        "1. Restore only a bounded tail from IndexedDB.",
        "2. Paint a small first window, then expand during idle time.",
        "3. Load older records in fixed batches when the user reaches the top.",
        "",
        "```ts",
        "const start = Math.max(0, rows.length - renderLimit);",
        "const visibleRows = rows.slice(start);",
        "```",
        "",
        "This keeps memory bounded while preserving stable source indexes and upward navigation.",
      ].join("\n") }],
    }, new Date(Date.parse(timestamp) + 25_000).toISOString()));
    lines.push(record("user", "reference_main_u2", "reference_main_a2", cwd, {
      role: "user",
      content: "Implement that bounded window and keep reconnect behavior intact.",
    }, new Date(Date.parse(timestamp) + 28_000).toISOString()));
    lines.push(record("assistant", "reference_main_a3", "reference_main_u2", cwd, {
      role: "assistant",
      content: [{ type: "text", text: "Done. The cache and render windows are bounded, older rows load in batches, and reconnect still resumes from the next source index." }],
    }, new Date(Date.parse(timestamp) + 31_000).toISOString()));
  }
  await writeFile(join(claudeRoot, `${id}.jsonl`), `${lines.join("\n")}\n`);
}

await writeFile(join(stateDir, "titles.json"), JSON.stringify(titles));
await writeFile(join(stateDir, "prefs.json"), JSON.stringify({
  version: 1,
  hiddenSessionIds: [],
  groups: [],
  pinnedGroupIds: [],
  pinnedSessionIds: ["reference_main"],
  thinkingTrigger: "think",
  autoTitleEnabled: false,
  autoTitleFrequency: 5,
  autoTitleLanguage: "auto",
  scratchSessionEnabled: false,
  scratchSessionPath: "",
  defaultClaudeModel: "",
  defaultClaudePermissionMode: "",
  defaultCodexModel: "",
  defaultCodexApprovalPreset: "",
  showActiveSection: true,
  showPeerSessions: true,
  messageDisplayStyle: "wechat",
  colorPreference: "dark",
}));

const app = await buildApp({
  home: root,
  stateDir,
  claudeRoot,
  codexRoot,
  frontendDist: join(process.cwd(), "frontend", "dist"),
  token: "visual-test-token",
  logger: false,
  startWatchers: false,
});
await app.listen({ host: "127.0.0.1", port: 3457 });
console.log(`visual fixture ready: ${root}`);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => void app.close().finally(() => process.exit(0)));
}

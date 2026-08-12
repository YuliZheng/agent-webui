import { copyFile, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildApp } from "../backend/dist/app.js";

const root = await mkdtemp(join(tmpdir(), "agent-webui-visual-"));
const claudeRoot = join(root, "claude");
const codexRoot = join(root, "codex");
const stateDir = join(root, "state");
const demoCwd = join(root, "workspace", "agent-webui-demo");
const demoFiles = join(demoCwd, "reference_assets");
await Promise.all([
  mkdir(claudeRoot, { recursive: true }),
  mkdir(codexRoot, { recursive: true }),
  mkdir(stateDir, { recursive: true }),
  mkdir(join(demoFiles, "portraits"), { recursive: true }),
]);

// Optional real-session visual regression input. The source is copied into the
// disposable fixture root, so QA can exercise a pathological transcript
// without pointing mutation-capable routes at the user's live Codex archive.
const visualCodexSession = process.env.AGENT_WEBUI_VISUAL_CODEX_SESSION;
if (visualCodexSession) {
  const importedCodexRoot = join(codexRoot, "imported");
  await mkdir(importedCodexRoot, { recursive: true });
  await copyFile(visualCodexSession, join(importedCodexRoot, basename(visualCodexSession)));
}
await Promise.all([
  writeFile(join(demoFiles, "README.md"), "# Reference assets\n\nA fixture for the remote file browser.\n"),
  writeFile(join(demoFiles, "preview.html"), "<!doctype html><meta charset=\"utf-8\"><style>body{font:16px system-ui;padding:2rem}h1{color:#0f766e}</style><h1>Sandboxed HTML preview</h1><p>This file renders without scripts.</p>"),
  writeFile(join(demoFiles, "notes.txt"), "Mobile and desktop file-browser fixture.\n"),
  writeFile(join(demoFiles, "clip.mp4"), "download-only fixture"),
  writeFile(join(demoFiles, "portraits", "selection.txt"), "Nested folder fixture.\n"),
]);

const now = new Date("2026-07-23T08:30:00.000Z");
const titles = {};
const samples = [
  ["reference_main", "Optimize transcript rendering", "🤖", demoCwd],
  ["reconnect", "Debug WebSocket reconnect", "🔧", demoCwd],
  ["auth_flow", "Review token authentication flow", "🔐", demoCwd],
  ["tailer", "Validate JSONL tail indexes", "📜", demoCwd],
  ["cache", "Bound the transcript cache", "🗃️", demoCwd],
  ["mobile", "Polish mobile chat layout", "📱", demoCwd],
  ["search", "Test full-content search", "🔎", demoCwd],
  ["markdown", "Improve Markdown export", "📝", demoCwd],
  ["tasks", "Reconstruct background tasks", "⚙️", demoCwd],
  ["preview", "Harden preview sandbox", "🛡️", demoCwd],
  ["tools", "Group consecutive tool calls", "🧰", demoCwd],
  ["new_session", "Refine new-session workflow", "🧩", demoCwd],
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
        "",
        `[Browse the reference assets](<${demoFiles}>)`,
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

// A compact Codex worker thread for the read-only sub-agent surface. Its
// parent is one of the interactive fixture sessions above so the recovery
// button can be exercised end-to-end without touching a real conversation.
const readonlyWorkerId = "readonly_worker";
const readonlyWorkerTimestamp = "2026-07-23T08:32:00.000Z";
titles[readonlyWorkerId] = { title: "Research Dolomites media", emoji: "🏔️", source: "auto" };
const readonlyWorkerLines = [
  JSON.stringify({
    timestamp: readonlyWorkerTimestamp,
    type: "session_meta",
    payload: {
      id: readonlyWorkerId,
      session_id: "reference_main",
      parent_thread_id: "reference_main",
      forked_from_id: "reference_main",
      timestamp: readonlyWorkerTimestamp,
      cwd: demoCwd,
      originator: "agent-webui",
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: "reference_main",
            depth: 1,
            agent_path: "/root/visual_worker",
            agent_nickname: "Visual",
            agent_role: null,
          },
        },
      },
      thread_source: "subagent",
      agent_path: "/root/visual_worker",
      agent_nickname: "Visual",
      model_provider: "openai",
      history_mode: "legacy",
      multi_agent_version: "v2",
    },
  }),
  JSON.stringify({
    timestamp: readonlyWorkerTimestamp,
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Find high-quality media connected to the Dolomites route." }],
    },
  }),
  JSON.stringify({
    timestamp: "2026-07-23T08:32:12.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "I will compare documentaries and local productions for the exact stops on the route." }],
    },
  }),
];
await writeFile(
  join(codexRoot, `rollout-2026-07-23T08-32-00-${readonlyWorkerId}.jsonl`),
  `${readonlyWorkerLines.join("\n")}\n`,
);

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
  frontendDist: process.env.AGENT_WEBUI_VISUAL_FRONTEND_DIST || join(process.cwd(), "frontend", "dist"),
  token: "visual-test-token",
  logger: false,
  startWatchers: false,
});
const port = Number(process.env.AGENT_WEBUI_VISUAL_PORT || 3457);
await app.listen({ host: "127.0.0.1", port });
console.log(`visual fixture ready: ${root}`);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => void app.close().finally(() => process.exit(0)));
}

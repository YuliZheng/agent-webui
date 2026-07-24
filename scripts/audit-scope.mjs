import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = new URL("..", import.meta.url);
const roots = ["shared", "backend", "frontend"];
const sourceExtensions = new Set([".ts", ".tsx", ".vue", ".css", ".html"]);
const forbiddenSource = [
  [/\/transcribe\b/i, "transcription endpoint"],
  [/voice-prompt/i, "voice prompt RPC"],
  [/\bMediaRecorder\b/, "microphone recorder"],
  [/\bSpeechRecognition\b/, "speech recognition"],
  [/\bSlack(?:Client|API|Socket|Channel|Avatar|Preference)\b/i, "Slack integration"],
  [/\bGemini(?:Client|API|Model)\b/i, "Gemini integration"],
  [/\b(?:ngrok|cloudflared|tailscale)\b/i, "tunnel integration"],
];
const forbiddenDependency = /(?:slack|gemini|ngrok|cloudflare|tailscale)/i;
const problems = [];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (["node_modules", "dist", "coverage", ".vite"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }
    const rel = relative(new URL("..", import.meta.url).pathname, path).replaceAll("\\", "/");
    if (/(?:^|\/)(?:voice|audio|slack|tunnel|transcrib)[^/]*\.(?:ts|vue)$/i.test(rel)) {
      problems.push(`${rel}: forbidden feature filename`);
    }
    if (!sourceExtensions.has(extname(entry.name))) continue;
    const source = await readFile(path, "utf8");
    for (const [pattern, label] of forbiddenSource) {
      if (pattern.test(source)) problems.push(`${rel}: ${label}`);
    }
  }
}

for (const workspace of roots) {
  const directory = new URL(`${workspace}/`, root);
  try {
    const pkg = JSON.parse(await readFile(new URL("package.json", directory), "utf8"));
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const name of Object.keys(pkg[section] ?? {})) {
        if (forbiddenDependency.test(name)) problems.push(`${workspace}/package.json: forbidden dependency ${name}`);
      }
    }
    await walk(directory.pathname);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Scope audit passed: no Slack, voice/transcription, Gemini, or tunnel implementation detected.");
}

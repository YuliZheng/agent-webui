import { homedir } from "node:os";
import { join } from "node:path";
import { SessionIndex } from "../backend/dist/services/session-index.js";
import { ContentSearchIndex } from "../backend/dist/services/content-search-index.js";
import { searchSessions } from "../backend/dist/actions/sessions.js";

const home = homedir();
const databasePath = process.argv[2] || join(home, ".agent-webui", "content-search-v7.sqlite");
const query = process.argv[3] || "";
const verify = process.argv.includes("--verify");
const sessions = new SessionIndex({
  claudeRoot: join(home, ".claude", "projects"),
  codexRoot: join(home, ".codex", "sessions"),
  cachePath: join(home, ".agent-webui", "session-index.json"),
  deferColdPreviews: true,
});
await sessions.scan({ incremental: true });

const startedAt = Date.now();
const contentIndex = await ContentSearchIndex.open(
  databasePath,
  event => process.stdout.write(`${JSON.stringify({ elapsedMs: Date.now() - startedAt, ...event })}\n`),
);
if (!contentIndex) process.exit(2);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => void contentIndex.close().finally(() => process.exit(0)));
}

contentIndex.sync(sessions.list());
await contentIndex.waitForIdle();
process.stdout.write(`${JSON.stringify({
  type: "complete",
  elapsedMs: Date.now() - startedAt,
  ...await contentIndex.stats(),
})}\n`);
if (query) {
  let diagnostic;
  const searchStartedAt = Date.now();
  const result = await searchSessions(sessions, query, {
    contentIndex,
    onDiagnostic: value => { diagnostic = value; },
  });
  process.stdout.write(`${JSON.stringify({
    type: "search",
    query,
    resultCount: result.matches.length,
    elapsedMs: Date.now() - searchStartedAt,
    diagnostic,
  })}\n`);
  if (verify) {
    let fallbackDiagnostic;
    const fallbackStartedAt = Date.now();
    const fallback = await searchSessions(sessions, query, {
      rgMinArchiveBytes: 0,
      onDiagnostic: value => { fallbackDiagnostic = value; },
    });
    const indexedIds = result.matches.map(match => match.id).sort();
    const fallbackIds = fallback.matches.map(match => match.id).sort();
    process.stdout.write(`${JSON.stringify({
      type: "verify",
      exactMatch: JSON.stringify(indexedIds) === JSON.stringify(fallbackIds),
      indexedResultCount: indexedIds.length,
      fallbackResultCount: fallbackIds.length,
      elapsedMs: Date.now() - fallbackStartedAt,
      diagnostic: fallbackDiagnostic,
    })}\n`);
  }
}
await contentIndex.close();

# Agent WebUI

Agent WebUI is a self-contained, single-user web interface for local Claude Code
and Codex sessions. It reads the agents' append-only JSONL session files and
launches the installed CLIs; it does not maintain a second transcript database.

## Requirements

- Node.js 20 or newer
- npm
- `claude` and/or `codex` available on `PATH` for starting new sessions

## Install and run

```sh
npm install
npm run build
npm start
```

The production server binds to `0.0.0.0` by default. On first start it creates a
random token at `~/.agent-webui/token` and prints a one-time token-binding URL.
Open that URL once on each browser; the token is exchanged for an HttpOnly
cookie and removed from subsequent URLs.

Use `npm run dev` for the Vite + Fastify development pair. The same token bind
works through `/api/auth/bind?token=...` in development.

Configuration is available through CLI flags and environment variables exposed
by the backend (`--host`, `--port`, `--token`, `AGENT_WEBUI_HOST`,
`AGENT_WEBUI_PORT`). Small server preferences are stored under
`~/.agent-webui/`; transcript data remains in the Claude and Codex session
directories.

## Security model

Agent WebUI is intended for a trusted local network. Every application/API
response and the WebSocket require the local token cookie, except the initial
token bind and unguessable sandboxed preview capability URLs. The server does
not provide a hosted relay, tunnel, Slack integration, or voice stack.

## Verification

```sh
npm test
npm run build
```

# Agent WebUI

Agent WebUI is a self-contained, single-user web interface for local Claude Code
and Codex sessions. It reads the agents' append-only JSONL session files and
launches the installed CLIs; it does not maintain a second transcript database.

## Requirements

- Node.js 20 or newer
- npm
- `claude` and/or `codex` available on `PATH` for starting new sessions

## Install

```sh
npm install
```

## Run on Windows

Always use the single `run.cmd` launcher, including after editing the source.
Double-click it in Explorer, or run `.\run.cmd` from PowerShell. It safely
builds only when the inputs changed, replaces the verified Agent WebUI process
only after a successful build, and starts exactly one instance on port 3457.

Open <http://127.0.0.1:3457/> afterward.

When the Tailscale CLI is installed, `run.cmd` also idempotently configures
Tailscale Serve for HTTPS. Tailnet devices can then open
<https://lggram.tail6c8b6c.ts.net/>; do not append `:3457` to that HTTPS URL.
If Tailscale is unavailable, local HTTP access still starts normally.

The production server binds to `0.0.0.0:3457` by default. On first start it
creates a random token at `~/.agent-webui/token`. Open the WebUI and paste that
value into the sign-in form; it is exchanged for an HttpOnly cookie. The server
does not print the bearer token into its logs.

Use `npm run dev` for the Vite + Fastify development pair. The same token bind
works through `/api/auth/bind?token=...` in development.

Configuration is available through CLI flags and environment variables exposed
by the backend (`--host`, `--port`, `--token`, `AGENT_WEBUI_HOST`,
`AGENT_WEBUI_PORT`). Small server preferences are stored under
`~/.agent-webui/`; transcript data remains in the Claude and Codex session
directories.

For example, override the production port with:

```powershell
$env:AGENT_WEBUI_PORT = "4567"
npm start
```

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

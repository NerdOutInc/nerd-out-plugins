# Nerd Out Notes Codex Plugin

Use Codex with the local MCP server hosted by Nerd Out Notes for Mac.

## Install

From the project where you want Codex to use the plugin:

```bash
npx codex-marketplace add NerdOutInc/nerd-out-plugins/plugins/nerd-out-notes --plugin --project
```

Start a new Codex thread after installing so the plugin tools are loaded.

## Setup

1. Open Nerd Out Notes for Mac.
2. Open Settings -> MCP Server.
3. Enable the local MCP server.
4. Reveal the access token.
5. Export it before starting Codex:

```bash
export NERD_OUT_MCP_TOKEN="<token-from-nerd-out-notes>"
```

The plugin connects to `http://127.0.0.1:38473/mcp`. That server is loopback-only
and runs inside the signed-in Nerd Out Notes Mac app.

## Tools

When the server is enabled, Codex can list notes, read note content, run keyword
and semantic search, check semantic index status, and list collaborators for
shared notes.

When "Allow writes" is enabled in Nerd Out Notes settings, Codex can also create
named notes and replace or append note content.

If Codex reports an authorization or connection error, confirm the Mac app is
open, the server is enabled, and `NERD_OUT_MCP_TOKEN` matches the currently
revealed token.

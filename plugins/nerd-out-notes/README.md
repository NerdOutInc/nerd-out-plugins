# Nerd Out Notes Codex Plugin

Use Codex with the local MCP server hosted by Nerd Out Notes for Mac.

## Install

In the Codex app, add
`https://github.com/NerdOutInc/nerd-out-plugins` as a plugin marketplace. Leave
**Sparse paths** blank, or include both `.agents/plugins` and
`plugins/nerd-out-notes` on separate lines. Then install **Nerd Out Notes** from
the Nerd Out marketplace.

Alternatively, install from the command line. Install globally so Codex can use
the plugin in every project (this plugin talks to the per-user Nerd Out Notes
Mac app, so it isn't project-specific):

```bash
npx codex-marketplace add NerdOutInc/nerd-out-plugins/plugins/nerd-out-notes --plugin --global
```

To scope it to the current repository instead, swap `--global` for `--project`.

Start a new Codex thread after installing so the plugin tools are loaded.

## Setup

1. Open Nerd Out Notes for Mac.
2. Open Settings -> MCP Server.
3. Enable the local MCP server.
4. Authorize Codex:

```bash
codex mcp login nerd-out-notes
```

A browser window opens to sign in to your Nerd Out account and approve access.
After approving, start a new Codex thread. No token export is needed.

> **Server name:** the plugin registers its server as `nerd-out-notes`, so that
> is the name used above. If `codex mcp login` reports it can't find the server,
> run `codex mcp list` to see the exact name Codex registered it under (a
> marketplace install may namespace it) and use that name instead.

The plugin connects to `http://127.0.0.1:38473/mcp`. That server is loopback-only
and runs inside the signed-in Nerd Out Notes Mac app.

<details>
<summary>Legacy token setup (older app builds)</summary>

If your Nerd Out Notes build does not support OAuth sign-in yet, use the shared
access token instead. This plugin version no longer wires the token env var, so
add the server manually:

1. In Nerd Out Notes, open Settings -> MCP Server and reveal the access token.
2. Export it and register the server directly with Codex:

```bash
export NERD_OUT_MCP_TOKEN="<token-from-nerd-out-notes>"
codex mcp add nerd-out-notes --url http://127.0.0.1:38473/mcp --bearer-token-env-var NERD_OUT_MCP_TOKEN
```

Updating Nerd Out Notes for Mac and running the `codex mcp login` command from
**Setup** above (use `codex mcp list` if the server name is namespaced) replaces
this setup.

</details>

## Tools

When the server is enabled, Codex can list notes, read note content, run keyword
and semantic search, check semantic index status, and list collaborators for
shared notes.

When "Allow writes" is enabled in Nerd Out Notes settings, Codex can also create
named notes and replace or append note content.

If Codex reports a connection error, confirm the Mac app is open and the server
is enabled. If Codex reports an authorization error, re-run the `codex mcp login`
command from **Setup** above and complete the browser sign-in (access may have
been revoked or expired). If login can't find the server, use `codex mcp list`
to confirm its exact name.

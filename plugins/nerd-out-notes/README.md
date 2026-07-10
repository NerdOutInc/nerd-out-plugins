# Nerd Out Notes Plugin

Use Codex or Claude Code with the local MCP server hosted by Nerd Out Notes
for Mac.

## Install

### Codex

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

### Claude Code

Add the marketplace and install the plugin:

```text
/plugin marketplace add NerdOutInc/nerd-out-plugins
/plugin install nerd-out-notes@nerd-out
```

Or from the command line (user scope makes it available in every project):

```bash
claude plugin marketplace add NerdOutInc/nerd-out-plugins
claude plugin install nerd-out-notes@nerd-out --scope user
```

Start a new thread after installing so the plugin tools are loaded.

## Setup

1. Open Nerd Out Notes for Mac.
2. Open Settings -> MCP Server.
3. Enable the local MCP server.
4. Authorize your agent.

For Codex:

```bash
codex mcp login nerd-out-notes
```

For Claude Code, run `/mcp` in a session and authenticate the Nerd Out Notes
server.

A browser window opens to sign in to your Nerd Out account and approve access.
After approving, start a new thread. No token export is needed.

> **Server name:** the plugin registers its server as `nerd-out-notes`, but the
> installed name may be namespaced — Claude Code registers plugin servers as
> `plugin:nerd-out-notes:nerd-out-notes`, and a Codex marketplace install may
> namespace it too. If login can't find the server, run `codex mcp list` or
> `claude mcp list` to see the exact name and use that instead.

The plugin connects to `http://127.0.0.1:38473/mcp`. That server is loopback-only
and runs inside the signed-in Nerd Out Notes Mac app.

<details>
<summary>Legacy token setup (older app builds)</summary>

If your Nerd Out Notes build does not support OAuth sign-in yet, use the shared
access token instead. This plugin version no longer wires the token env var, so
add the server manually:

1. In Nerd Out Notes, open Settings -> MCP Server and reveal the access token.
2. Register the server directly with your agent.

For Codex:

```bash
export NERD_OUT_MCP_TOKEN="<token-from-nerd-out-notes>"
codex mcp add nerd-out-notes --url http://127.0.0.1:38473/mcp --bearer-token-env-var NERD_OUT_MCP_TOKEN
```

For Claude Code:

```bash
claude mcp add --transport http nerd-out-notes http://127.0.0.1:38473/mcp --header "Authorization: Bearer <token-from-nerd-out-notes>"
```

Updating Nerd Out Notes for Mac and running the OAuth authorization from
**Setup** above (use `codex mcp list` or `claude mcp list` if the server name
is namespaced) replaces this setup.

</details>

## Tools

When the server is enabled, the agent can list notes, read note content, run
keyword and semantic search, check semantic index status, and list
collaborators for shared notes. When "Allow writes" is enabled, it can also
create or update named notes, append to or materialize DailyNotes, and add real
backlink nodes through `update_note_content`.

## Skills

This plugin can ship multiple skills; both agents discover every subdirectory
under `skills/` that contains a `SKILL.md`. It currently includes:

- `nerd-out-notes` for direct note, search, and MCP workflows.
- `nerd-out-journal` for a global journal: it asks you to choose a confirmed,
  write-ready NerdOut workspace on first use, saves that choice in a per-agent
  global config (`$CODEX_HOME/nerd-out-journal.json` for Codex,
  `$CLAUDE_CONFIG_DIR/nerd-out-journal.json` — default `~/.claude` — for
  Claude Code), and then automatically records useful task notes plus a daily
  summary with backlinks for future tasks.

In Codex, invoke skills as `$nerd-out-notes` and `$nerd-out-journal`; in Claude
Code, they are namespaced as `/nerd-out-notes:nerd-out-notes` and
`/nerd-out-notes:nerd-out-journal`.

The journal skill is summary-first and never stores credentials or full
conversation transcripts by default. Enable MCP writes in the app before using
it to create or update notes.

If the agent reports a connection error, confirm the Mac app is open and the
server is enabled. If it reports an authorization error, re-run the
authorization from **Setup** above and complete the browser sign-in (access may
have been revoked or expired). If login can't find the server, use
`codex mcp list` or `claude mcp list` to confirm its exact name.

# Nerd Out Notes Plugin

Use Claude (Desktop, Cowork, or Claude Code) or Codex with the local MCP
server hosted by Nerd Out Notes for Mac.

## How the plugin connects

The Mac app hosts a loopback-only MCP server at `http://127.0.0.1:38473/mcp`.
Claude clients refuse plain-http URLs on some surfaces (Claude Desktop chat
routes url-type servers through cloud custom connectors, which require public
HTTPS and can never reach a loopback listener), so this plugin ships a
**stdio bridge** instead of a URL: `bridge/index.mjs` waits for the app, then
runs a bundled copy of [`mcp-remote`](https://github.com/geelen/mcp-remote)
(MIT — `bridge/LICENSE-mcp-remote.txt`) that proxies stdio to the loopback
server and handles the MCP OAuth browser sign-in, caching tokens in
`~/.mcp-auth`. The bridge runs `node` from your PATH (any Node.js 18+). Both
Claude (`.mcp.json`) and Codex (`.codex-plugin/mcp.json`) register the same
bridge, so the two agents share one connection path and one token cache.

The bundle is regenerated with `cd bridge/build && npm install && npm run build`
(see `bridge/build/build.mjs`) — do not edit `bridge/mcp-remote-proxy.bundle.mjs`
by hand.

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

### Claude Desktop (chat and Cowork)

Open **Customize → Plugins**, choose **Add marketplace**, and enter
`NerdOutInc/nerd-out-plugins`. Then install **Nerd Out Notes** from the
marketplace list. No terminal needed.

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

No explicit login step is needed for either agent: the first time the
plugin's bridge connects (in Claude Desktop, Cowork, Claude Code, or Codex),
a browser window opens to sign in to your Nerd Out account and approve
access. Approve, then start a new conversation or thread. Tokens are cached
and refreshed in `~/.mcp-auth` and shared between Claude and Codex, so this
happens once per Mac.

> **Server name:** the plugin registers its server as `nerd-out-notes`, but the
> installed name may be namespaced — Claude Code registers plugin servers as
> `plugin:nerd-out-notes:nerd-out-notes`. If you don't see the server, run
> `codex mcp list` or `claude mcp list` to see the exact name.

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

Updating Nerd Out Notes for Mac and completing the browser sign-in from
**Setup** above (it runs automatically the first time the plugin's bridge
connects) replaces this setup.

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
  Claude Code), and then records useful task notes plus a daily summary with
  backlinks for future tasks. A bundled `UserPromptSubmit` hook notices the
  valid opt-in config and adds the journal reminder to each later prompt, so
  the skill no longer has to discover a file before it has been loaded.

In Codex, invoke skills as `$nerd-out-notes:nerd-out-notes` and
`$nerd-out-notes:nerd-out-journal`; in Claude Code, use
`/nerd-out-notes:nerd-out-notes` and
`/nerd-out-notes:nerd-out-journal`.

The journal skill is summary-first and never stores credentials or full
conversation transcripts by default. Enable MCP writes in the app before using
it to create or update notes.

After installing or updating the plugin, start a new thread so the hook is
loaded. Codex requires a one-time review and trust decision for plugin hooks;
open `/hooks` if Codex reports that this hook is awaiting review. The hook only
checks the current agent's `nerd-out-journal.json` shape and injects agent
context. It does not read note bodies, validate workspace access, or write
notes; the journal skill and MCP server keep those responsibilities.

If the agent reports a connection error, confirm the Mac app is open and the
server is enabled. If it reports an authorization error, start a new
conversation so the bridge re-runs the browser sign-in (access may have been
revoked or expired); deleting `~/.mcp-auth` forces a fresh sign-in. If you
don't see the server, use `codex mcp list` or `claude mcp list` to confirm
its exact name.

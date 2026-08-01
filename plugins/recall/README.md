# Recall Plugin

Use Claude (Desktop, Cowork, or Claude Code) or Codex with the local MCP
server hosted by Recall for Mac.

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
bridge implementation, but pass their own OAuth client names and keep
separate credential caches under `~/.mcp-auth/recall/`. When Recall's
one-click installer has prepared the integration, the bridge and journal hook
use Recall's pinned private Node runtime after verifying that it launches a
supported Node version. Otherwise they fall back to Node.js 18+ from your
PATH, which keeps manual and non-Recall installs working even if an old private
runtime is damaged. Recall's
Authorized clients list can therefore show and revoke **Claude** and
**Codex** independently instead of listing both as **MCP CLI Proxy**.

The bundle is regenerated with `cd bridge/build && npm install && npm run build`
(see `bridge/build/build.mjs`) — do not edit `bridge/mcp-remote-proxy.bundle.mjs`
by hand.

## Install

The direct-download Recall Mac app can perform this setup from
**Settings → Integrations**. It installs the marketplace/plugin and prepares a
pinned private Node + ACP runtime in one action. OAuth consent still happens
on first agent use, and workspace access remains explicit.

### Codex

In the Codex app, add
`https://github.com/NerdOutInc/recall-plugins` as a plugin marketplace. Leave
**Sparse paths** blank, or include both `.agents/plugins` and
`plugins/recall` on separate lines. Then install **Recall** from
the Recall marketplace.

Alternatively, install from the command line. Install globally so Codex can use
the plugin in every project (this plugin talks to the per-user Recall Mac app,
so it isn't project-specific):

```bash
codex plugin marketplace add NerdOutInc/recall-plugins \
  --ref main \
  --sparse .agents/plugins \
  --sparse plugins/recall
codex plugin add recall@recall
```

Older Codex versions without `codex plugin` can use
`npx codex-marketplace add NerdOutInc/recall-plugins/plugins/recall --plugin --global`.

### Claude Desktop (chat and Cowork)

Open **Customize → Plugins**, choose **Add marketplace**, and enter
`NerdOutInc/recall-plugins`. Then install **Recall** from the
marketplace list. No terminal needed.

### Claude Code

Add the marketplace and install the plugin:

```text
/plugin marketplace add NerdOutInc/recall-plugins
/plugin install recall@recall
```

Or from the command line (user scope makes it available in every project):

```bash
claude plugin marketplace add NerdOutInc/recall-plugins
claude plugin install recall@recall --scope user
```

Start a new thread after installing so the plugin tools are loaded.

### Moving an existing install to Recall

Recall uses new marketplace, plugin, MCP server, skill, journal-config, and
OAuth-cache identifiers. Existing installations do not update across those
identity changes automatically. Add the Recall marketplace, install
**Recall**, start a new thread, and approve the browser sign-in once for
each host. Journal users should invoke `$recall:recall-journal` once to
create `recall-journal.json` and select a workspace.

After the new Recall plugin works and its browser sign-in succeeds, retire the
legacy plugin so its hooks and MCP connection do not run alongside Recall:

```bash
claude plugin disable nerd-out-notes@nerd-out --scope user
codex plugin remove nerd-out-notes@nerd-out
```

Run only the command for the host you migrated. Recall's direct-download Mac
app performs this cleanup automatically, but only after it verifies the
replacement plugin. Sandboxed builds and manual installs use the steps above.

## Setup

1. Open Recall for Mac.
2. Open Settings → Integrations and install the agent, or complete the manual
   install above.
3. Open Settings → MCP Server and choose block/read/write access per workspace.
4. Start a new agent thread and authorize that host.

No explicit login step is needed for either agent: the first time the
plugin's bridge connects (in Claude Desktop, Cowork, Claude Code, or Codex),
a browser window opens to sign in to your Recall account and approve
access. Approve, then start a new conversation or thread. Each agent
authorizes once because its dynamic OAuth registration and refreshed tokens
are cached separately under `~/.mcp-auth/recall/`.

After upgrading from a version that displayed **MCP CLI Proxy**, authorize
Claude and Codex again to create the newly named registrations. Existing
**MCP CLI Proxy** rows cannot be mapped back to a host reliably; revoke those
legacy rows in Recall after the named clients are working.

> **Server name:** the plugin registers its server as `recall`, but the
> installed name may be namespaced — Claude Code registers plugin servers as
> `plugin:recall:recall`. If you don't see the server, run
> `codex mcp list` or `claude mcp list` to see the exact name.

The plugin connects to `http://127.0.0.1:38473/mcp`. That server is loopback-only
and runs inside the signed-in Recall Mac app.

<details>
<summary>Legacy token setup (older app builds)</summary>

If your Recall build does not support OAuth sign-in yet, use the shared
access token instead. This plugin version no longer wires the token env var, so
add the server manually:

1. In Recall, open Settings -> MCP Server and reveal the access token.
2. Register the server directly with your agent.

For Codex:

```bash
export NERD_OUT_MCP_TOKEN="<token-from-recall>"
codex mcp add recall --url http://127.0.0.1:38473/mcp --bearer-token-env-var NERD_OUT_MCP_TOKEN
```

For Claude Code:

```bash
claude mcp add --transport http recall http://127.0.0.1:38473/mcp --header "Authorization: Bearer <token-from-recall>"
```

Updating Recall for Mac and completing the browser sign-in from
**Setup** above (it runs automatically the first time the plugin's bridge
connects) replaces this setup.

</details>

## Tools

Recall advertises `list_notes`, `read_note`, `keyword_search`,
`semantic_search`, `get_index_status`, and `list_workspaces`. The
`create_note` and `update_note_content` write tools appear when at least one
workspace is set to **Read & write** in Recall's MCP Server settings. Reads and
writes are filtered independently by each workspace's Block / Read only / Read
& write policy; an unconfigured workspace stays blocked.

## Skills

This plugin can ship multiple skills; both agents discover every subdirectory
under `skills/` that contains a `SKILL.md`. It currently includes:

- `recall` for direct note, search, and MCP workflows.
- `recall-journal` for a global journal: it asks you to choose a confirmed,
  write-ready Recall workspace on first use, saves that choice in a per-agent
  global config (`$CODEX_HOME/recall-journal.json` for Codex,
  `$CLAUDE_CONFIG_DIR/recall-journal.json` — default `~/.claude` — for
  Claude Code), and then journals live: it opens a marker-identified entry
  when substantive work begins, appends short progress updates at
  checkpoints, and closes with a final block plus a daily summary with
  backlinks for future tasks — so an interrupted session leaves a partial,
  resumable record instead of nothing. A bundled `UserPromptSubmit` hook
  notices the valid opt-in config and adds the journal reminder to each
  later prompt, so the skill no longer has to discover a file before it has
  been loaded. The reminder names the configured workspace and works in both
  directions: it tells the agent to search existing journal notes when a
  task may relate to prior work — so the journal is read back as memory, not
  just written — and to open, update, and finalize the task's entry as the
  work happens. A project can also get its own journal:
  ask the agent to select a Recall workspace for the current project and it
  saves the project's root path under `projects` in the same config. Sessions
  working anywhere inside that path — subfolders and worktrees checked out
  under the repo included — then journal to and recall from the project's
  workspace instead of the global one.

In Codex, invoke skills as `$recall:recall` and
`$recall:recall-journal`; in Claude Code, use
`/recall:recall` and
`/recall:recall-journal`.

The journal skill is summary-first and never stores credentials or full
conversation transcripts by default. Enable MCP writes in the app before using
it to create or update notes.

After installing or updating the plugin, start a new thread so the hook is
loaded. Codex requires a one-time review and trust decision for plugin hooks;
open `/hooks` if Codex reports that this hook is awaiting review. The hook only
checks the current agent's `recall-journal.json` shape and injects agent
context, including the workspace name and id that apply to the session — the
project's workspace when the session runs inside a saved project path, the
global workspace otherwise — so the agent can search the journal right away.
It does not read note bodies, validate workspace access, or write notes; the
journal skill and MCP server keep those responsibilities.

If the agent reports a connection error, confirm the Mac app is open and the
server is enabled. If it reports an authorization error, start a new
conversation so the bridge re-runs the browser sign-in (access may have been
revoked or expired); deleting the affected agent's directory under
`~/.mcp-auth/recall/` forces a fresh sign-in without clearing the
other agent. If you don't see the server, use `codex mcp list` or
`claude mcp list` to confirm its exact name.

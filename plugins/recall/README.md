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
server and handles MCP OAuth, caching tokens in `~/.mcp-auth`. Normal first use
opens the browser. Plugin `0.15.0` retires the legacy DailyNote journal summary
target — the Recall server no longer creates DailyNotes — and migrates stale
configs to Today timeline or no-summary with a one-time prompt, retaining Today
summaries from `0.14.0`, Project-aware destinations from `0.13.0`, the OAuth
coordinator from `0.12.0`, read + write consent-scope alignment from `0.12.1`,
and Codex hook trust preflight from `0.12.2`. A
compatible Direct Recall build can use the coordinator to present the same
explicit consent inside Recall without changing cache ownership. The bridge
runs `node` from your PATH (any Node.js 18+). Both Claude (`.mcp.json`) and Codex
(`.codex-plugin/mcp.json`) register the same bridge implementation, but pass
their own OAuth client names and keep separate credential caches under
`~/.mcp-auth/recall/`. When Recall's
one-click installer has prepared the integration, the bridge and journal hook
use Recall's pinned private Node runtime after verifying that it launches a
supported Node version. Otherwise they fall back to Node.js 18+ from your
PATH, which keeps manual and non-Recall installs working even if an old private
runtime is damaged. Recall's
Authorized clients list can therefore show and revoke **Claude** and
**Codex** independently instead of listing both as **MCP CLI Proxy**.

The proxy and coordinator bundles are regenerated from tracked source with
`cd bridge/build && npm ci && npm run build` (see `bridge/build/build.mjs`) — do
not edit either generated bundle by hand. `npm run verify` type-checks and tests
the source, then byte-compares the committed artifacts.

## Install

The direct-download Recall Mac app can perform this setup from
**Settings → Integrations**. It installs the marketplace/plugin and prepares a
pinned private Node + ACP runtime in one action. Compatible builds can continue
into in-app OAuth consent; older builds leave consent to first agent use.
Workspace access remains explicit either way.

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
each host. Journal users should invoke `$recall:recall-journal` once to create
`recall-journal.json`, choose current-filesystem-project or global scope, and
select a workspace plus optional Recall Project.

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

No separate login command is needed. A compatible Direct Recall build can
present the server-owned consent page in Recall during installation; otherwise
the first bridge connection opens a browser for the same sign-in and consent.
Approve, then start a new conversation or thread. Each agent authorizes once
because its dynamic OAuth registration and refreshed tokens are cached
separately under `~/.mcp-auth/recall/`.

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
`semantic_search`, `get_index_status`, `list_workspaces`, and `list_projects`.
Named-note list/search tools accept an explicit workspace + Project filter, and
`create_note` can file a new named note in that exact Project.
`create_today_note` makes one short, retry-safe Today card in an explicit
workspace and optional Project, with real backlinks to detailed notes. The
`create_note`, `create_today_note`, and `update_note_content` write tools appear
when at least one workspace is set to **Read & write** in Recall's MCP Server settings. Reads and
writes are filtered independently by each workspace's Block / Read only / Read
& write policy; an unconfigured workspace stays blocked.

## Skills

This plugin can ship multiple skills; both agents discover every subdirectory
under `skills/` that contains a `SKILL.md`. It currently includes:

- `recall` for direct note, search, and MCP workflows.
- `recall-journal` for a Project-aware journal: on first use it shows the
  current filesystem project's absolute path and asks whether to configure that
  project or a global default. It then asks for a confirmed, write-ready Recall
  workspace and, when that workspace has Projects, an optional Recall Project.
  It saves the choice in a per-agent config (`$CODEX_HOME/recall-journal.json` for Codex,
  `$CLAUDE_CONFIG_DIR/recall-journal.json` — default `~/.claude` — for
  Claude Code), and then journals live: it opens a marker-identified entry
  when substantive work begins, appends short progress updates at
  checkpoints, and closes with a final block plus one tiny ELI5 Today card with
  a detailed-note backlink (or none when day summaries are disabled) — so an
  interrupted session leaves a partial, resumable record instead of nothing.
  A config that still selects the retired legacy DailyNote summary target gets
  a one-time prompt to switch to Today or none; the Recall server no longer
  creates DailyNotes, so the skill never writes them. A bundled
  `UserPromptSubmit` hook notices the valid opt-in config and adds the journal
  reminder to each later prompt, so the skill no longer has to discover a file
  before it has been loaded. The reminder names the configured workspace and works in both
  directions: it tells the agent to search existing journal notes when a
  task may relate to prior work — so the journal is read back as memory, not
  just written — and to open, update, and finalize the task's entry as the
  work happens. A filesystem project can have its own destination even without
  a global default: the skill saves its canonical root path under `projects` in
  the same config. Sessions
  working anywhere inside that path — subfolders and worktrees checked out
  under the repo included — then journal to and recall from the project's
  workspace and optional Recall Project instead of the global destination.

In Codex, invoke skills as `$recall:recall` and
`$recall:recall-journal`; in Claude Code, use
`/recall:recall` and
`/recall:recall-journal`.

The journal skill is summary-first and never stores credentials or full
conversation transcripts by default. Enable MCP writes in the app before using
it to create or update notes.

After installing or updating the plugin, start a new thread so the hook is
loaded. Codex requires a one-time review and trust decision for plugin hooks;
the first explicit `$recall:recall-journal` invocation checks Codex's active
hook inventory and asks you to use `/hooks` when the Recall handler is new,
modified, disabled, or missing. Hook trust remains your decision: the skill
can detect and explain the state but never changes Codex's trust configuration
or bypasses the review. Claude Code has no separate per-hook trust switch, so
this preflight is Codex-only. The hook itself only checks the current agent's
`recall-journal.json` shape and injects agent context, including the workspace
and optional Recall Project that apply to the session — the filesystem
project's destination when its saved path matches, the global destination
otherwise — so the agent can search the journal right away.
It does not read note bodies, validate workspace access, or write notes; the
journal skill and MCP server keep those responsibilities.

If the agent reports a connection error, confirm the Mac app is open and the
server is enabled. If it reports an authorization error, start a new
conversation so the bridge re-runs the browser sign-in (access may have been
revoked or expired); deleting the affected agent's directory under
`~/.mcp-auth/recall/` forces a fresh sign-in without clearing the
other agent. If you don't see the server, use `codex mcp list` or
`claude mcp list` to confirm its exact name.

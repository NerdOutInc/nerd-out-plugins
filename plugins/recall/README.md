# Recall Plugin

Use Claude (Desktop, Cowork, or Claude Code) or Codex with the local MCP
server hosted by Recall for Mac.

## How the plugin connects

The Mac app hosts a loopback-only MCP server at `http://127.0.0.1:38473/mcp`.
Claude clients refuse plain-http URLs on some surfaces (Claude Desktop chat
routes url-type servers through cloud custom connectors, which require public
HTTPS and can never reach a loopback listener), so this plugin ships a
**stdio bridge** instead of a URL. Its preferred path finds the Recall-signed
`recall-mcp-bridge` helper inside the installed app and pumps MCP stdio through
the app's local Unix socket. Recall verifies that helper and applies the user's
native local-bridge approval; this path needs no browser sign-in and stores no
OAuth tokens on disk.

When the signed helper is absent — normally because the installed Recall build
predates the local bridge — or explicitly reports an unsupported protocol,
`bridge/index.mjs` falls back to a bundled copy of
[`mcp-remote`](https://github.com/geelen/mcp-remote) (MIT —
`bridge/LICENSE-mcp-remote.txt`). That legacy path proxies stdio to the
loopback HTTP server, opens browser OAuth when needed, and keeps host-specific
credentials under `~/.mcp-auth/recall/`. A denial, revocation, signature
failure, or protocol error on the local-socket path is surfaced as an error and
never silently downgraded to OAuth.

Plugin `0.19.0` capability-probes newer Recall builds for note activity,
canonical Markdown, and revision-checked content updates while keeping the
older note workflow intact. Plugin `0.18.0` adds a reader-only version 3
activation path for future structured project memory while leaving the current
version 1/2 named-note journal unchanged. Plugin `0.17.0` introduced the signed
local bridge; `0.16.0` made the journal human-first; `0.15.0` retired DailyNote
creation; `0.14.0` added Today summaries; `0.13.0` added Project-aware
destinations; and the `0.12.x` line added the OAuth coordinator, scope
alignment, and Codex hook trust preflight.

Both Claude (`.mcp.json`) and Codex (`.codex-plugin/mcp.json`) register the same
bridge implementation but pass their own client names. When Recall's one-click
installer has prepared the integration, the bridge and journal hook use
Recall's pinned private Node runtime after verifying that it launches a
supported Node version. Otherwise they fall back to Node.js 18+ from `PATH`,
which keeps manual and non-Recall installs working if the private runtime is
missing or damaged.

The proxy and coordinator bundles are regenerated from tracked source with
`cd bridge/build && npm ci && npm run build` (see `bridge/build/build.mjs`) — do
not edit either generated bundle by hand. `npm run verify` type-checks and tests
the source, then byte-compares the committed artifacts.

## Install

The direct-download Recall Mac app can perform this setup from
**Settings → Integrations**. It installs the marketplace/plugin and prepares a
pinned private Node + ACP runtime in one action. The first plugin connection
uses Recall's native local-bridge approval when supported; older builds use the
browser OAuth fallback. Workspace access remains explicit either way.

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

Recall uses new marketplace, plugin, MCP server, skill, and journal-config
identifiers, plus separate OAuth cache paths when the fallback is active.
Existing installations do not update across those identity changes
automatically. Add the Recall marketplace, install
**Recall**, start a new thread, and approve the native prompt in Recall. An
older Recall build opens browser OAuth instead. Journal users should invoke
`$recall:recall-journal` once to create
`recall-journal.json`, choose current-filesystem-project or global scope, and
select a workspace plus optional Recall Project.

After the new Recall plugin works and its connection is approved, retire the
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
4. Start a new agent thread and approve the local bridge in Recall.

No separate login command is needed. A compatible Direct Recall build can
use the native local-bridge prompt on first connection. Bring Recall to the
front, approve it, then start a new conversation or thread. The approval can be
revoked or reset under **Settings → MCP Server → Local bridge access**. Older
Recall builds fall back to browser OAuth and keep Claude and Codex credentials
separate under `~/.mcp-auth/recall/`.

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
Newer builds also advertise `list_note_activity` for one named note's accepted
activity and extend `read_note` / `update_note_content` with canonical Markdown
plus opaque revision tokens for conditional writes. The skills inspect the
live schemas before using those additions; if the complete revision pair is
not present, they keep the legacy HTML/readback workflow without mixing fields.
Named-note list/search tools accept an explicit workspace + Project filter, and
`create_note` can file a new named note in that exact Project.
`create_today_note` makes one short, retry-safe Today card in an explicit
workspace and optional Project, with real backlinks to detailed notes. Note
Markdown supports `<details><summary>` blocks, which render as native
collapsible toggles in the editor. The
`create_note`, `create_today_note`, and `update_note_content` write tools — plus
`rename_note` on newer app builds, for title-only renames of named notes —
appear
when at least one workspace is set to **Write** in Recall's MCP Server
settings. Reads and writes are filtered independently by each workspace's
**Block**, **Read**, or **Write** policy; an unconfigured workspace stays
blocked.

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
  Claude Code), and then journals live into one note per chat thread: a
  dateless topic-phrase title, a short always-visible intro, and one
  collapsible toggle entry per checkpoint whose summary line reads like plain
  English while agent detail and hidden bookkeeping (journal marker, thread
  id, timestamps) stay inside the collapsed details. The thread's agent
  curates its own note as the work evolves — refreshing the intro, merging
  entries, and retitling when the thread changes direction — and on days the
  thread wraps up meaningful work it adds at most one tiny ELI5 Today card
  with a `Full journal entry` backlink (or none when day summaries are
  disabled) — so an interrupted session leaves a partial, resumable record
  instead of nothing.
  A config that still selects the retired legacy DailyNote summary target gets
  a one-time prompt to switch to Today or none; the Recall server no longer
  creates DailyNotes, so the skill never writes them. A bundled
  `UserPromptSubmit` hook notices the valid opt-in config and adds the journal
  reminder to each later prompt, so the skill no longer has to discover a file
  before it has been loaded. The reminder names the configured workspace — and
  the chat thread's stable id when the host provides one — and works in both
  directions: it tells the agent to search existing journal notes when a
  task may relate to prior work — so the journal is read back as memory, not
  just written — and to open, update, and wrap up the thread's note as the
  work happens. A filesystem project can have its own destination even without
  a global default: the skill saves its canonical root path under `projects` in
  the same config. Sessions
  working anywhere inside that path — subfolders and worktrees checked out
  under the repo included — then journal to and recall from the project's
  workspace and optional Recall Project instead of the global destination.

  The hook can also read the reserved version 3 project-memory activation
  shape. In this compatibility release that mode is intentionally read-only:
  it resolves the current project and loads compact structured context when the
  app advertises those tools, but never writes either structured sessions or
  the legacy note/Today journal. Current setup and reconfiguration continue to
  write version 2 only. Version 3 also bypasses the legacy named-note
  capability probe, so one prompt can never enter both protocols.

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
conversation, choose **Allow again** under Recall's **Settings → MCP Server →
Local bridge access**, and approve the native prompt. If the MCP log says
`transport: oauth-http`, the older OAuth fallback is active instead; deleting
the affected agent's directory under `~/.mcp-auth/recall/` forces a fresh
browser sign-in without clearing the other agent. If you don't see the server,
use `codex mcp list` or `claude mcp list` to confirm its exact name.
